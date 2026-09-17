import {
  ArrayTypeMap,
  NodeInputKeyEnum,
  VARIABLE_NODE_ID,
  WorkflowIOValueTypeEnum
} from '../../constants';
import { CanonicalWorkflowDataSchema, type CanonicalWorkflowData } from '../../migration/schema';
import { stripCanvasSizeInputs } from '../../migration/migrate';
import {
  FlowNodeTypeEnum,
  isNestedChildSystemNodeType,
  isNestedParentNodeType
} from '../../node/constant';
import type { StoreNodeItemType } from '../../type/node';
import type { FlowNodeInputItemType } from '../../type/io';
import type { AppChatConfigType } from '../../../app/type';
import { isValidArrayReferenceValue } from '../../utils';
import { buildNodeTemplateContext, getNodeContainerCheckError } from '../../template/context';
import type { NodeViewState, WorkflowFieldIdentity, WorkflowNodeData } from '../types';
import { getWorkflowGlobalVariables } from '../variables';
import {
  addFieldIdentity,
  cloneValue,
  getError,
  getFieldIdentity,
  getFieldIdentityKey,
  isObject,
  valuesEqual
} from './kernel';
import { updateReferenceGraphNode } from './referenceModule';
import type {
  CanonicalResult,
  EdgeRecord,
  GraphIndex,
  IndexedNode,
  MutationMeta,
  NodeRecord,
  NodeViewStore,
  ReferenceGraph,
  RuntimeDocument
} from './types';

/**
 * Document 领域的无状态部分：canonical 转换、node/graph 索引构建与增量维护、
 * placement 与删除规则、事务内的变更记录登记。
 * Document module 的有状态工厂只组合这些规则，不重复实现。
 */

const systemProtectedDeleteTypes = new Set<FlowNodeTypeEnum>([
  FlowNodeTypeEnum.pluginInput,
  FlowNodeTypeEnum.pluginOutput,
  FlowNodeTypeEnum.nestedStart,
  FlowNodeTypeEnum.nestedEnd,
  FlowNodeTypeEnum.loopRunStart
]);
const uniqueRootNodeTypes = new Set<FlowNodeTypeEnum>([
  FlowNodeTypeEnum.workflowStart,
  FlowNodeTypeEnum.pluginInput,
  FlowNodeTypeEnum.pluginOutput
]);

export const hasForbidDelete = (value: unknown): boolean =>
  isObject(value) && value.forbidDelete === true;

/** 复用未改变的字段对象，维持 scoped field snapshot 的稳定 identity。 */
export const reuseEqualItems = <T>(previous: T[], next: T[]): T[] =>
  next.map((item, index) => (valuesEqual(previous[index], item) ? previous[index] : item));

export const buildNodeIndex = (nodes: NodeRecord[]): Map<string, IndexedNode> =>
  new Map(nodes.map((node, index) => [node.data.nodeId, { record: node, index }] as const));

export const recordNodeChange = ({
  meta,
  nodeId,
  before,
  after,
  afterIndex
}: {
  meta: MutationMeta;
  nodeId: string;
  before?: NodeRecord;
  after?: NodeRecord;
  afterIndex?: number;
}) => {
  const previous = meta.nodeChanges.get(nodeId);
  if (!before && !after && !previous?.before) {
    meta.nodeChanges.delete(nodeId);
    meta.changedNodeIds.delete(nodeId);
    return;
  }
  meta.nodeChanges.set(nodeId, {
    before: previous?.before ?? before,
    after,
    afterIndex: afterIndex ?? previous?.afterIndex
  });
  meta.changedNodeIds.add(nodeId);
};

export const recordEdgeChange = ({
  meta,
  edge,
  kind
}: {
  meta: MutationMeta;
  edge: EdgeRecord;
  kind: 'add' | 'remove';
}) => {
  if (kind === 'add') {
    meta.removedEdges.delete(edge.id);
    meta.addedEdges.set(edge.id, edge);
  } else {
    if (meta.addedEdges.delete(edge.id)) {
      meta.changedEdgeIds.delete(edge.id);
      return;
    }
    meta.removedEdges.set(edge.id, edge);
  }
  meta.changedEdgeIds.add(edge.id);
};

export const collectNodeFieldChanges = ({
  changedFieldIds,
  before,
  after
}: {
  changedFieldIds: Map<string, WorkflowFieldIdentity>;
  before?: WorkflowNodeData;
  after?: WorkflowNodeData;
}) => {
  const previous = new Map<string, WorkflowFieldIdentity>();
  const next = new Map<string, WorkflowFieldIdentity>();
  before?.inputs.forEach((field) => {
    const identity = getFieldIdentity({ nodeId: before.nodeId, field, kind: 'input' });
    previous.set(getFieldIdentityKey(identity), identity);
  });
  before?.outputs.forEach((field) => {
    const identity = getFieldIdentity({ nodeId: before.nodeId, field, kind: 'output' });
    previous.set(getFieldIdentityKey(identity), identity);
  });
  after?.inputs.forEach((field) => {
    const identity = getFieldIdentity({ nodeId: after.nodeId, field, kind: 'input' });
    next.set(getFieldIdentityKey(identity), identity);
  });
  after?.outputs.forEach((field) => {
    const identity = getFieldIdentity({ nodeId: after.nodeId, field, kind: 'output' });
    next.set(getFieldIdentityKey(identity), identity);
  });

  const keys = new Set([...previous.keys(), ...next.keys()]);
  keys.forEach((key) => {
    const previousIdentity = previous.get(key);
    const nextIdentity = next.get(key);
    const previousField = before
      ? previousIdentity?.kind === 'input'
        ? before.inputs.find((field) => field.key === previousIdentity.key)
        : before.outputs.find((field) => field.id === previousIdentity?.key)
      : undefined;
    const nextField = after
      ? nextIdentity?.kind === 'input'
        ? after.inputs.find((field) => field.key === nextIdentity.key)
        : after.outputs.find((field) => field.id === nextIdentity?.key)
      : undefined;
    if (!valuesEqual(previousField, nextField)) {
      addFieldIdentity(changedFieldIds, nextIdentity ?? previousIdentity!);
    }
  });
};

/**
 * 提交一次节点记录替换：同步 staged 引用图，只在语义数据真的变化时登记 node change，
 * 并收集受影响的字段身份。replace/updateNode/updateField 三个命令共用这一条提交路径。
 * 视图变化由 Node View module 单独登记，这里只比较语义数据。
 */
export const commitNodeRecordUpdate = ({
  meta,
  referenceGraph,
  nodeId,
  index,
  before,
  after
}: {
  meta: MutationMeta;
  referenceGraph: ReferenceGraph;
  nodeId: string;
  index: number;
  before: NodeRecord;
  after: NodeRecord;
}) => {
  updateReferenceGraphNode({ graph: referenceGraph, before: before.data, after: after.data });
  if (!valuesEqual(before.data, after.data)) {
    recordNodeChange({ meta, nodeId, before, after, afterIndex: index });
  }
  collectNodeFieldChanges({
    changedFieldIds: meta.changedFieldIds,
    before: before.data,
    after: after.data
  });
};

/**
 * 把入站节点拆成语义记录与视图；两侧分别归 Document 与 Node View module 所有。
 * 容器尺寸类隐藏 input 在这里被剥掉：画布测量值不进入 Workflow Document，命令也写不进来。
 */
export const splitNode = (
  node: StoreNodeItemType,
  forbidDelete = hasForbidDelete(node)
): { record: NodeRecord; view: NodeViewState } => {
  const { position, isFolded, ...data } = cloneValue(node);
  return {
    record: {
      data: { ...data, inputs: stripCanvasSizeInputs(data.inputs) },
      ...(forbidDelete ? { forbidDelete: true } : {})
    },
    view: {
      ...(position ? { position } : {}),
      ...(isFolded !== undefined ? { isFolded } : {})
    }
  };
};

/** 只接受 strict canonical 数据，拆分 Node Data/Node View 并分配私有 Runtime Edge ID。 */
export const buildDocument = (input: unknown, edgeIdStart = 0): CanonicalResult => {
  const canonical = CanonicalWorkflowDataSchema.parse(input);
  const rawNodes = isObject(input) && Array.isArray(input.nodes) ? input.nodes : [];
  const views: NodeViewStore = new Map();
  const nodes = canonical.nodes.map((node, index) => {
    const { record, view } = splitNode(node, hasForbidDelete(rawNodes[index]));
    views.set(record.data.nodeId, view);
    return record;
  });
  const nodeIds = new Set<string>();
  nodes.forEach((node) => {
    if (nodeIds.has(node.data.nodeId))
      throw new Error(`Duplicate workflow node id: ${node.data.nodeId}`);
    nodeIds.add(node.data.nodeId);
  });

  let nextEdgeId = edgeIdStart;
  const edges = canonical.edges.map((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`Workflow edge references a missing node: ${edge.source} -> ${edge.target}`);
    }
    return { id: `edge-${nextEdgeId++}`, data: cloneValue(edge) };
  });
  return {
    document: {
      nodes,
      edges,
      chatConfig: cloneValue(canonical.chatConfig)
    },
    views,
    nextEdgeId
  };
};

/**
 * 将内部分离存储重新组合成外部 canonical document：语义记录来自 Document，
 * position/isFolded 来自 Node View module。持久化结构只在这个边界组装一次。
 */
export const documentToCanonical = ({
  document,
  views
}: {
  document: RuntimeDocument;
  views: NodeViewStore;
}): CanonicalWorkflowData => ({
  nodes: document.nodes.map(({ data }) => {
    const view = views.get(data.nodeId);
    return {
      ...cloneValue(data),
      ...(view?.position ? { position: cloneValue(view.position) } : {}),
      ...(view?.isFolded !== undefined ? { isFolded: view.isFolded } : {})
    };
  }),
  edges: document.edges.map((edge) => cloneValue(edge.data)),
  chatConfig: cloneValue(document.chatConfig)
});

const isForbiddenDeleteNode = (node: NodeRecord) =>
  node.forbidDelete === true || systemProtectedDeleteTypes.has(node.data.flowNodeType);

/** 判断节点在指定容器下的放置是否合法；Issue module 也直接复用这条纯规则。 */
export const getPlacementError = ({
  working,
  node,
  parentId
}: {
  working: RuntimeDocument;
  node: NodeRecord;
  parentId?: string;
}): 'invalid_placement' | undefined => {
  if (!parentId) {
    return isNestedChildSystemNodeType(node.data.flowNodeType) ||
      node.data.flowNodeType === FlowNodeTypeEnum.loopRunBreak
      ? 'invalid_placement'
      : undefined;
  }

  const parent = working.nodes.find(({ data }) => data.nodeId === parentId);
  if (!parent || !isNestedParentNodeType(parent.data.flowNodeType)) return 'invalid_placement';

  const parentType = parent.data.flowNodeType;
  const isValidSystemChild =
    ((node.data.flowNodeType === FlowNodeTypeEnum.nestedStart ||
      node.data.flowNodeType === FlowNodeTypeEnum.nestedEnd) &&
      (parentType === FlowNodeTypeEnum.loop || parentType === FlowNodeTypeEnum.parallelRun)) ||
    (node.data.flowNodeType === FlowNodeTypeEnum.loopRunStart &&
      parentType === FlowNodeTypeEnum.loopRun) ||
    (node.data.flowNodeType === FlowNodeTypeEnum.loopRunBreak &&
      parentType === FlowNodeTypeEnum.loopRun);
  if (isNestedChildSystemNodeType(node.data.flowNodeType)) {
    return isValidSystemChild ? undefined : 'invalid_placement';
  }
  if (isValidSystemChild) return undefined;

  const context = buildNodeTemplateContext({
    sourceNode: undefined,
    edges: [],
    getNodeById: () => undefined,
    isSidebar: true,
    targetParentType: parentType,
    hasToolNode: working.nodes.some(
      ({ data }) =>
        data.parentNodeId === parentId && data.flowNodeType === FlowNodeTypeEnum.toolCall
    ),
    hasLoopRunNode: working.nodes.some(
      ({ data }) => data.parentNodeId === parentId && data.flowNodeType === FlowNodeTypeEnum.loopRun
    )
  });
  return context && getNodeContainerCheckError({ node: node.data, context })
    ? 'invalid_placement'
    : undefined;
};

/** 校验新增或替换节点的容器、系统节点唯一性，保证 placement 规则只有一个入口。 */
export const validateNodePlacement = ({
  working,
  node,
  excludeNodeId
}: {
  working: RuntimeDocument;
  node: NodeRecord;
  excludeNodeId?: string;
}) => {
  if (getPlacementError({ working, node, parentId: node.data.parentNodeId })) {
    throw getError('invalid_placement', 'Node placement is not allowed');
  }
  if (
    uniqueRootNodeTypes.has(node.data.flowNodeType) &&
    working.nodes.some(
      ({ data }) =>
        data.nodeId !== excludeNodeId &&
        data.flowNodeType === node.data.flowNodeType &&
        !data.parentNodeId
    )
  ) {
    throw getError('invalid_placement', 'Only one root system node is allowed');
  }
  if (
    node.data.parentNodeId &&
    isNestedChildSystemNodeType(node.data.flowNodeType) &&
    working.nodes.some(
      ({ data }) =>
        data.nodeId !== excludeNodeId &&
        data.parentNodeId === node.data.parentNodeId &&
        data.flowNodeType === node.data.flowNodeType
    )
  ) {
    throw getError('invalid_placement', 'Only one system child is allowed per container');
  }
};

/**
 * 删除前校验：受保护节点不能单独删除，条件循环必须保留一个 Break 节点。
 * 父节点同时被删除时豁免，因为整棵子树会一起消失。
 */
export const validateNodeDeletion = ({
  nodes,
  deletedIds
}: {
  nodes: NodeRecord[];
  deletedIds: ReadonlySet<string>;
}) => {
  const isParentDeleted = (node: NodeRecord) =>
    node.data.parentNodeId !== undefined && deletedIds.has(node.data.parentNodeId);

  nodes.forEach((node) => {
    if (!deletedIds.has(node.data.nodeId)) return;
    if (isForbiddenDeleteNode(node) && !isParentDeleted(node)) {
      throw getError('invalid_command', `Node cannot be deleted: ${node.data.nodeId}`);
    }
    if (node.data.flowNodeType !== FlowNodeTypeEnum.loopRunBreak || isParentDeleted(node)) return;

    const parent = nodes.find(({ data }) => data.nodeId === node.data.parentNodeId);
    if (parent?.data.flowNodeType !== FlowNodeTypeEnum.loopRun) return;
    const isConditionalLoop =
      parent.data.inputs.find((input) => input.key === NodeInputKeyEnum.loopRunMode)?.value ===
      'conditional';
    if (!isConditionalLoop) return;

    const hasRemainingBreak = nodes.some(
      ({ data }) =>
        data.parentNodeId === node.data.parentNodeId &&
        data.flowNodeType === FlowNodeTypeEnum.loopRunBreak &&
        !deletedIds.has(data.nodeId)
    );
    if (!hasRemainingBreak) {
      throw getError('invalid_command', 'Conditional loop must retain a break node');
    }
  });
};

/**
 * 判定本笔事务是否改变工作流结构：边集合变化，或节点记录增删、父子归属、
 * 节点类型、outputs 发生变化。结构信号决定 affected 闭包与整图投影是否需要失效。
 */
export const resolveStructureChanged = (meta: MutationMeta): boolean =>
  meta.changedEdgeIds.size > 0 ||
  [...meta.nodeChanges.values()].some(
    ({ before, after }) =>
      !before ||
      !after ||
      before.data.parentNodeId !== after.data.parentNodeId ||
      before.data.flowNodeType !== after.data.flowNodeType ||
      !valuesEqual(before.data.outputs, after.data.outputs)
  );

/** 构建私有邻接索引；索引只服务于 runtime 内部 BFS，不对外暴露。 */
export const buildGraphIndex = (nodes: NodeRecord[], edges: EdgeRecord[]): GraphIndex => {
  const bySource = new Map<string, EdgeRecord[]>();
  const byTarget = new Map<string, EdgeRecord[]>();
  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  const edgeById = new Map<string, EdgeRecord>();
  nodes.forEach(({ data }) => {
    if (!data.parentNodeId) return;
    parentByChild.set(data.nodeId, data.parentNodeId);
    const children = childrenByParent.get(data.parentNodeId) ?? [];
    children.push(data.nodeId);
    childrenByParent.set(data.parentNodeId, children);
  });
  edges.forEach((edge) => {
    edgeById.set(edge.id, edge);
    const sourceEdges = bySource.get(edge.data.source) ?? [];
    sourceEdges.push(edge);
    bySource.set(edge.data.source, sourceEdges);
    const targetEdges = byTarget.get(edge.data.target) ?? [];
    targetEdges.push(edge);
    byTarget.set(edge.data.target, targetEdges);
  });
  return { bySource, byTarget, parentByChild, childrenByParent, edgeById };
};

/** 把一笔事务的局部图变化写进已有索引：边增删与父子归属迁移。 */
export const applyGraphIndexChanges = (graphIndex: GraphIndex, meta: MutationMeta) => {
  const removeEdge = (edge: EdgeRecord) => {
    graphIndex.edgeById.delete(edge.id);
    const drop = (bucket: Map<string, EdgeRecord[]>, key: string) => {
      const bucketEdges = bucket.get(key);
      if (!bucketEdges) return;
      const next = bucketEdges.filter((item) => item.id !== edge.id);
      if (next.length > 0) bucket.set(key, next);
      else bucket.delete(key);
    };
    drop(graphIndex.bySource, edge.data.source);
    drop(graphIndex.byTarget, edge.data.target);
  };
  const addEdge = (edge: EdgeRecord) => {
    graphIndex.edgeById.set(edge.id, edge);
    const sourceEdges = graphIndex.bySource.get(edge.data.source) ?? [];
    graphIndex.bySource.set(edge.data.source, [...sourceEdges, edge]);
    const targetEdges = graphIndex.byTarget.get(edge.data.target) ?? [];
    graphIndex.byTarget.set(edge.data.target, [...targetEdges, edge]);
  };

  meta.removedEdges.forEach(removeEdge);
  meta.addedEdges.forEach(addEdge);
  meta.nodeChanges.forEach(({ before, after }) => {
    if (before?.data.parentNodeId && before.data.parentNodeId !== after?.data.parentNodeId) {
      graphIndex.parentByChild.delete(before.data.nodeId);
      const children = graphIndex.childrenByParent.get(before.data.parentNodeId) ?? [];
      const next = children.filter((nodeId) => nodeId !== before.data.nodeId);
      if (next.length > 0) graphIndex.childrenByParent.set(before.data.parentNodeId, next);
      else graphIndex.childrenByParent.delete(before.data.parentNodeId);
    }
    if (after?.data.parentNodeId && before?.data.parentNodeId !== after.data.parentNodeId) {
      graphIndex.parentByChild.set(after.data.nodeId, after.data.parentNodeId);
      const children = graphIndex.childrenByParent.get(after.data.parentNodeId) ?? [];
      graphIndex.childrenByParent.set(after.data.parentNodeId, [...children, after.data.nodeId]);
    }
    if (!after) {
      graphIndex.parentByChild.delete(before?.data.nodeId ?? '');
      graphIndex.childrenByParent.delete(before?.data.nodeId ?? '');
    }
  });
};

/** 收集所有流程开始节点 id。 */
export const collectWorkflowStartIds = (nodes: NodeRecord[]) =>
  new Set(
    nodes
      .filter(({ data }) => data.flowNodeType === FlowNodeTypeEnum.workflowStart)
      .map(({ data }) => data.nodeId)
  );

/** 按节点变更增量维护流程开始节点集合。 */
export const applyWorkflowStartChanges = (startIds: Set<string>, meta: MutationMeta) => {
  meta.nodeChanges.forEach(({ before, after }, nodeId) => {
    if (before?.data.flowNodeType === FlowNodeTypeEnum.workflowStart) startIds.delete(nodeId);
    if (after?.data.flowNodeType === FlowNodeTypeEnum.workflowStart) startIds.add(nodeId);
  });
};

/** 收集容器后代节点 id；childrenByParent 来自 graph index。 */
export const collectDescendantNodeIds = (
  childrenByParent: Map<string, string[]>,
  rootIds: ReadonlySet<string>
) => {
  const descendants = new Set<string>();
  const visit = (nodeId: string) => {
    childrenByParent.get(nodeId)?.forEach((childId) => {
      if (descendants.has(childId)) return;
      descendants.add(childId);
      visit(childId);
    });
  };
  rootIds.forEach(visit);
  return descendants;
};

/** Persisted Derived Field：容器子节点清单。执行层读它，因此必须留在持久化数据里。 */
const childrenNodeIdListKey = NodeInputKeyEnum.childrenNodeIdList;

/** Persisted Derived Field：容器数组输入，其值类型由被引用来源的类型决定。 */
const containerArrayInputKeys = new Set<string>([
  NodeInputKeyEnum.nestedInputArray,
  NodeInputKeyEnum.loopRunInputArray
]);

/** Document 判断本笔事务是否触碰了需要重算值类型的容器数组输入。 */
export const isContainerArrayInputKey = (key: string) => containerArrayInputKeys.has(key);

/** 条件模式的 Loop Run 没有数组输入，与旧编辑器一致跳过值类型推断。 */
const skipsArrayValueTypeInference = (data: WorkflowNodeData, key: string) =>
  key === NodeInputKeyEnum.loopRunInputArray &&
  data.flowNodeType === FlowNodeTypeEnum.loopRun &&
  data.inputs.find((input) => input.key === NodeInputKeyEnum.loopRunMode)?.value === 'conditional';

/**
 * 推断容器数组输入的值类型：取第一个引用的来源类型并映射成对应数组类型。
 * 口径与旧编辑器的渲染副作用一致，引用缺失或无法解析时回落到 arrayAny。
 */
const resolveArrayInputValueType = ({
  value,
  nodes,
  nodeIds,
  chatConfig
}: {
  value: unknown;
  nodes: NodeRecord[];
  nodeIds: string[];
  chatConfig: AppChatConfigType;
}): WorkflowIOValueTypeEnum => {
  if (!Array.isArray(value) || value.length === 0 || !isValidArrayReferenceValue(value, nodeIds)) {
    return WorkflowIOValueTypeEnum.arrayAny;
  }
  // isValidArrayReferenceValue 是类型守卫，这里 value 已收窄成引用数组。
  const [sourceNodeId, outputId] = value[0];
  const sourceType =
    sourceNodeId === VARIABLE_NODE_ID
      ? getWorkflowGlobalVariables({ chatConfig }).find((item) => item.key === outputId)?.valueType
      : nodes
          .find(({ data }) => data.nodeId === sourceNodeId)
          ?.data.outputs.find((output) => output.id === outputId)?.valueType;
  return ArrayTypeMap[sourceType as keyof typeof ArrayTypeMap] ?? WorkflowIOValueTypeEnum.arrayAny;
};

/** 重算单个节点的派生字段；没有变化时返回原 inputs 数组，保持字段身份稳定。 */
const deriveNodeInputs = ({
  node,
  nodes,
  nodeIds,
  chatConfig,
  childrenByParent
}: {
  node: NodeRecord;
  nodes: NodeRecord[];
  nodeIds: string[];
  chatConfig: AppChatConfigType;
  childrenByParent: Map<string, string[]>;
}): FlowNodeInputItemType[] => {
  let inputs = node.data.inputs;

  const childrenInput = inputs.find((input) => input.key === childrenNodeIdListKey);
  if (childrenInput) {
    const children = childrenByParent.get(node.data.nodeId) ?? [];
    if (!valuesEqual(childrenInput.value ?? [], children)) {
      inputs = inputs.map((input) =>
        input === childrenInput ? { ...input, value: [...children] } : input
      );
    }
  }

  const arrayInput = inputs.find(
    (input) =>
      containerArrayInputKeys.has(input.key) && !skipsArrayValueTypeInference(node.data, input.key)
  );
  if (arrayInput) {
    const valueType = resolveArrayInputValueType({
      value: arrayInput.value,
      nodes,
      nodeIds,
      chatConfig
    });
    if (arrayInput.valueType !== valueType) {
      inputs = inputs.map((input) => (input === arrayInput ? { ...input, valueType } : input));
    }
  }

  return inputs;
};

/**
 * 重算全部 Persisted Derived Field：容器子节点清单与容器数组输入的值类型。
 * 两者的值完全由文档其他内容决定，但执行层要读，所以必须持久化；由 Runtime 在结构变化、
 * chatConfig 变化或数组输入自身变化时重算，渲染副作用不再写回文档。
 * 返回替换后的节点数组与逐节点变化，调用方据此登记 node change 与字段变化。
 */
export const applyPersistedDerivedFields = ({
  nodes,
  chatConfig
}: {
  nodes: NodeRecord[];
  chatConfig: AppChatConfigType;
}): {
  nodes: NodeRecord[];
  changes: Array<{ index: number; before: NodeRecord; after: NodeRecord }>;
} => {
  const childrenByParent = new Map<string, string[]>();
  const nodeIds: string[] = [];
  nodes.forEach(({ data }) => {
    nodeIds.push(data.nodeId);
    if (!data.parentNodeId) return;
    const children = childrenByParent.get(data.parentNodeId) ?? [];
    children.push(data.nodeId);
    childrenByParent.set(data.parentNodeId, children);
  });

  const changes: Array<{ index: number; before: NodeRecord; after: NodeRecord }> = [];
  let nextNodes = nodes;
  nodes.forEach((node, index) => {
    const inputs = deriveNodeInputs({ node, nodes, nodeIds, chatConfig, childrenByParent });
    if (inputs === node.data.inputs) return;
    const after: NodeRecord = { ...node, data: { ...node.data, inputs } };
    if (nextNodes === nodes) nextNodes = nodes.slice();
    nextNodes[index] = after;
    changes.push({ index, before: node, after });
  });
  return { nodes: nextNodes, changes };
};
