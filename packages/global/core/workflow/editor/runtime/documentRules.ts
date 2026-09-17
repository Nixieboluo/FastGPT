import { NodeInputKeyEnum } from '../../constants';
import { CanonicalWorkflowDataSchema, type CanonicalWorkflowData } from '../../migration/schema';
import {
  FlowNodeTypeEnum,
  isNestedChildSystemNodeType,
  isNestedParentNodeType
} from '../../node/constant';
import type { StoreNodeItemType } from '../../type/node';
import { buildNodeTemplateContext, getNodeContainerCheckError } from '../../template/context';
import type { WorkflowFieldIdentity, WorkflowNodeData } from '../types';
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
 * 提交一次节点记录替换：同步 staged 引用图，只在数据或视图真的变化时登记 node change，
 * 并收集受影响的字段身份。replace/updateNode/updateField 三个命令共用这一条提交路径。
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
  if (!valuesEqual(before.data, after.data) || !valuesEqual(before.view, after.view)) {
    recordNodeChange({ meta, nodeId, before, after, afterIndex: index });
  }
  collectNodeFieldChanges({
    changedFieldIds: meta.changedFieldIds,
    before: before.data,
    after: after.data
  });
  if (!valuesEqual(before.view, after.view)) meta.changedNodeViewIds.add(nodeId);
};

export const splitNode = (
  node: StoreNodeItemType,
  forbidDelete = hasForbidDelete(node)
): NodeRecord => {
  const { position, isFolded, ...data } = cloneValue(node);
  return {
    data,
    view: {
      ...(position ? { position } : {}),
      ...(isFolded !== undefined ? { isFolded } : {})
    },
    ...(forbidDelete ? { forbidDelete: true } : {})
  };
};

/** 只接受 strict canonical 数据，拆分 Node Data/Node View 并分配私有 Runtime Edge ID。 */
export const buildDocument = (input: unknown, edgeIdStart = 0): CanonicalResult => {
  const canonical = CanonicalWorkflowDataSchema.parse(input);
  const rawNodes = isObject(input) && Array.isArray(input.nodes) ? input.nodes : [];
  const nodes = canonical.nodes.map((node, index) =>
    splitNode(node, hasForbidDelete(rawNodes[index]))
  );
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
    nextEdgeId
  };
};

/** 将内部 document 重新组合成外部 canonical document，供比较与 Debug 快照共用。 */
export const documentToCanonical = (document: RuntimeDocument): CanonicalWorkflowData => ({
  nodes: document.nodes.map(({ data, view }) => ({
    ...cloneValue(data),
    ...(view.position ? { position: cloneValue(view.position) } : {}),
    ...(view.isFolded !== undefined ? { isFolded: view.isFolded } : {})
  })),
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
