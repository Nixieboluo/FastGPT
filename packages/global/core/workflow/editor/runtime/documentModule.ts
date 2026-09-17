import { NodeInputKeyEnum, NodeOutputKeyEnum } from '../../constants';
import { CanonicalWorkflowDataSchema, type CanonicalWorkflowData } from '../../migration/schema';
import {
  FlowNodeTypeEnum,
  isNestedChildSystemNodeType,
  isNestedParentNodeType
} from '../../node/constant';
import { StoreEdgeItemTypeSchema, type StoreEdgeItemType } from '../../type/edge';
import { StoreNodeItemTypeSchema, type StoreNodeItemType } from '../../type/node';
import { AppChatConfigTypeSchema } from '../../../app/type';
import {
  buildNodeTemplateContext,
  getNodeContainerCheckError,
  isNodeConnectionAllowed
} from '../../template/context';
import { moduleTemplatesFlat } from '../../template/constants';
import { isWorkflowEdgeSourceHandleValid } from '../utils';
import { applyWorkflowStartInputAutoFill } from '../startAutoFill';
import type { RuntimeEdgeId, WorkflowFieldIdentity, WorkflowNodeData } from '../types';
import {
  addFieldIdentity,
  cloneValue,
  getError,
  getFieldIdentity,
  getFieldIdentityKey,
  isObject,
  valuesEqual
} from './kernel';
import { mergeNodeView } from './nodeViewModule';
import { updateReferenceGraphNode } from './referenceModule';
import type {
  CanonicalResult,
  EdgeRecord,
  GraphIndex,
  IndexedNode,
  MutationMeta,
  NodeRecord,
  NodeRecordChange,
  RuntimeDocument,
  SemanticCommand,
  TransactionContext
} from './types';

/**
 * Document module：拥有 Node Data、edges、chatConfig、Runtime Edge ID、node/graph 索引，
 * 以及语义命令的校验与 reduce。它是 module 依赖链的第一环，只依赖 kernel。
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

const hasForbidDelete = (value: unknown): boolean => isObject(value) && value.forbidDelete === true;

/** 复用未改变的字段对象，维持 scoped field snapshot 的稳定 identity。 */
const reuseEqualItems = <T>(previous: T[], next: T[]): T[] =>
  next.map((item, index) => (valuesEqual(previous[index], item) ? previous[index] : item));

const buildNodeIndex = (nodes: NodeRecord[]): Map<string, IndexedNode> =>
  new Map(nodes.map((node, index) => [node.data.nodeId, { record: node, index }] as const));

const recordNodeChange = ({
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

const recordEdgeChange = ({
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

const collectNodeFieldChanges = ({
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

const splitNode = (node: StoreNodeItemType, forbidDelete = hasForbidDelete(node)): NodeRecord => {
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
const buildDocument = (input: unknown, edgeIdStart = 0): CanonicalResult => {
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

/** Create the Workflow Document module. */
export const createDocumentModule = (canonicalData: CanonicalWorkflowData) => {
  const initial = buildDocument(canonicalData);
  let document = initial.document;
  let nextEdgeId = initial.nextEdgeId;
  let nodeIndex: Map<string, IndexedNode> = buildNodeIndex(document.nodes);
  let graphIndex: GraphIndex = {
    bySource: new Map(),
    byTarget: new Map(),
    parentByChild: new Map(),
    childrenByParent: new Map(),
    edgeById: new Map()
  };
  let workflowStartIds = new Set<string>();

  const getDocument = () => document;
  const setDocument = (next: RuntimeDocument) => {
    document = next;
  };
  const getNodeIndex = () => nodeIndex;
  const getGraphIndex = () => graphIndex;
  const getNodeById = (nodeId: string) => nodeIndex.get(nodeId)?.record;

  /** 重建私有邻接索引；索引只服务于 runtime 内部 BFS。 */
  const rebuildGraphIndex = () => {
    const bySource = new Map<string, EdgeRecord[]>();
    const byTarget = new Map<string, EdgeRecord[]>();
    const parentByChild = new Map<string, string>();
    const childrenByParent = new Map<string, string[]>();
    const edgeById = new Map<string, EdgeRecord>();
    document.nodes.forEach(({ data }) => {
      if (data.parentNodeId) {
        parentByChild.set(data.nodeId, data.parentNodeId);
        const children = childrenByParent.get(data.parentNodeId) ?? [];
        children.push(data.nodeId);
        childrenByParent.set(data.parentNodeId, children);
      }
    });
    document.edges.forEach((edge) => {
      edgeById.set(edge.id, edge);
      const sourceEdges = bySource.get(edge.data.source) ?? [];
      sourceEdges.push(edge);
      bySource.set(edge.data.source, sourceEdges);
      const targetEdges = byTarget.get(edge.data.target) ?? [];
      targetEdges.push(edge);
      byTarget.set(edge.data.target, targetEdges);
    });
    graphIndex = { bySource, byTarget, parentByChild, childrenByParent, edgeById };
  };

  const removeEdgeFromIndex = (edge: EdgeRecord) => {
    graphIndex.edgeById.delete(edge.id);
    (['bySource', 'byTarget'] as const).forEach((key) => {
      const bucketKey = key === 'bySource' ? edge.data.source : edge.data.target;
      const bucket = graphIndex[key].get(bucketKey);
      if (!bucket) return;
      const next = bucket.filter((item) => item.id !== edge.id);
      if (next.length > 0) graphIndex[key].set(bucketKey, next);
      else graphIndex[key].delete(bucketKey);
    });
  };

  const addEdgeToIndex = (edge: EdgeRecord) => {
    graphIndex.edgeById.set(edge.id, edge);
    const sourceEdges = graphIndex.bySource.get(edge.data.source) ?? [];
    graphIndex.bySource.set(edge.data.source, [...sourceEdges, edge]);
    const targetEdges = graphIndex.byTarget.get(edge.data.target) ?? [];
    graphIndex.byTarget.set(edge.data.target, [...targetEdges, edge]);
  };

  /** 提交普通命令的局部图变化；只有 replace 或 undo/redo 才走全量构建。 */
  const updateGraphIndexIncrementally = (meta: MutationMeta) => {
    meta.removedEdges.forEach(removeEdgeFromIndex);
    meta.addedEdges.forEach(addEdgeToIndex);
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

  const rebuildNodeIndex = () => {
    nodeIndex = buildNodeIndex(document.nodes);
  };

  /** 普通字段/节点更新只替换对应 Map entry；删除才需要重排数组索引。 */
  const updateNodeIndexIncrementally = (meta: MutationMeta) => {
    const hasDeletion = [...meta.nodeChanges.values()].some(
      ({ before, after }) => before && !after
    );
    if (hasDeletion) {
      rebuildNodeIndex();
      return;
    }
    meta.nodeChanges.forEach(({ after, afterIndex }, nodeId) => {
      if (!after) return;
      const index = afterIndex ?? nodeIndex.get(nodeId)?.index;
      if (index !== undefined) nodeIndex.set(nodeId, { record: after, index });
    });
  };

  const updateWorkflowStartIndex = (meta: MutationMeta) => {
    meta.nodeChanges.forEach(({ before, after }, nodeId) => {
      if (before?.data.flowNodeType === FlowNodeTypeEnum.workflowStart) {
        workflowStartIds.delete(nodeId);
      }
      if (after?.data.flowNodeType === FlowNodeTypeEnum.workflowStart) {
        workflowStartIds.add(nodeId);
      }
    });
  };

  const rebuildWorkflowStartIds = () => {
    workflowStartIds = new Set(
      document.nodes
        .filter(({ data }) => data.flowNodeType === FlowNodeTypeEnum.workflowStart)
        .map(({ data }) => data.nodeId)
    );
  };

  /** 纯 geometry 事务只替换节点记录并同步索引，不触发语义索引重建。 */
  const commitNodeRecords = (nodeChanges: NodeRecordChange[]) => {
    const nextNodes = document.nodes.slice();
    nodeChanges.forEach(({ index, after }) => {
      nextNodes[index] = after;
      nodeIndex.set(after.data.nodeId, { record: after, index });
    });
    document = { ...document, nodes: nextNodes };
  };

  /** undo/redo 后按已提交文档刷新指定节点记录，保留其余索引项身份。 */
  const refreshNodeIndexRecords = (nodeIds: readonly string[]) => {
    nodeIds.forEach((nodeId) => {
      const indexedNode = nodeIndex.get(nodeId);
      if (indexedNode) {
        nodeIndex.set(nodeId, {
          record: document.nodes[indexedNode.index],
          index: indexedNode.index
        });
      }
    });
  };

  const getWorkingNode = (nodeId: string, meta?: MutationMeta) => {
    const change = meta?.nodeChanges.get(nodeId);
    if (change) return change.after;
    return nodeIndex.get(nodeId)?.record;
  };

  const getWorkingNodeIndex = ({
    working,
    nodeId,
    meta
  }: {
    working: RuntimeDocument;
    nodeId: string;
    meta?: MutationMeta;
  }) => {
    const change = meta?.nodeChanges.get(nodeId);
    if (change)
      return change.after ? (change.afterIndex ?? working.nodes.indexOf(change.after)) : -1;
    return nodeIndex.get(nodeId)?.index ?? -1;
  };

  const getFlowNodeById = (working: RuntimeDocument, nodeId: string, meta?: MutationMeta) => {
    const indexedNode = getWorkingNode(nodeId, meta);
    if (indexedNode) return { ...indexedNode.data, id: indexedNode.data.nodeId };
    const data = working.nodes.find(({ data }) => data.nodeId === nodeId)?.data;
    return data ? { ...data, id: data.nodeId } : undefined;
  };

  /** 判断边的 source handle 是否仍由分支节点当前配置提供。 */
  const isSourceEdgeValid = (edge: EdgeRecord) => {
    const sourceData = getNodeById(edge.data.source)?.data;
    return isWorkflowEdgeSourceHandleValid(
      sourceData ? { ...sourceData, id: sourceData.nodeId } : undefined,
      edge.data.sourceHandle
    );
  };

  const getDescendantNodeIds = (rootIds: ReadonlySet<string>) => {
    const descendants = new Set<string>();
    const visit = (nodeId: string) => {
      graphIndex.childrenByParent.get(nodeId)?.forEach((childId) => {
        if (descendants.has(childId)) return;
        descendants.add(childId);
        visit(childId);
      });
    };
    rootIds.forEach(visit);
    return descendants;
  };

  const isForbiddenDeleteNode = (node: NodeRecord) =>
    node.forbidDelete === true || systemProtectedDeleteTypes.has(node.data.flowNodeType);

  const getPlacementError = ({
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
      edges: working.edges.map(({ data }) => data),
      getNodeById: () => undefined,
      isSidebar: true,
      targetParentType: parentType,
      hasToolNode: working.nodes.some(
        ({ data }) =>
          data.parentNodeId === parentId && data.flowNodeType === FlowNodeTypeEnum.toolCall
      ),
      hasLoopRunNode: working.nodes.some(
        ({ data }) =>
          data.parentNodeId === parentId && data.flowNodeType === FlowNodeTypeEnum.loopRun
      )
    });
    return context && getNodeContainerCheckError({ node: node.data, context })
      ? 'invalid_placement'
      : undefined;
  };

  /** 校验新增或替换节点的容器、系统节点唯一性，保证 placement 规则只有一个入口。 */
  const validateNodePlacement = ({
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

  const isEdgeConnectionAllowed = (
    working: RuntimeDocument,
    edge: StoreEdgeItemType,
    ignoreEdgeId?: RuntimeEdgeId,
    meta?: MutationMeta
  ) => {
    const source = getFlowNodeById(working, edge.source, meta);
    const target = getFlowNodeById(working, edge.target, meta);
    if (
      !source ||
      !target ||
      edge.source === edge.target ||
      !isWorkflowEdgeSourceHandleValid(source, edge.sourceHandle)
    ) {
      return false;
    }
    if (
      working.edges.some(
        ({ id, data }) =>
          id !== ignoreEdgeId &&
          data.target === edge.target &&
          data.targetHandle === NodeOutputKeyEnum.selectedTools
      )
    ) {
      return false;
    }
    if (
      working.edges.some(
        ({ id, data }) =>
          id !== ignoreEdgeId &&
          data.source === edge.source &&
          data.target === edge.target &&
          data.sourceHandle === edge.sourceHandle
      )
    ) {
      return false;
    }
    const targetTemplate = moduleTemplatesFlat.find((item) => item.id === target.flowNodeType);
    return isNodeConnectionAllowed({
      targetTemplate,
      targetNode: target,
      sourceNode: source,
      edges: working.edges.map(({ data }) => data),
      handleId: edge.sourceHandle,
      getNodeById: (nodeId) => (nodeId ? getFlowNodeById(working, nodeId, meta) : undefined)
    });
  };

  /** 将一次新增/连线意图产生的流程开始引用补丁并入同一 working transaction。 */
  const applyWorkflowStartAutoFill = ({ working, meta, referenceGraph }: TransactionContext) => {
    const getWorkingTargets = (nodeId: string) => {
      const targets = (graphIndex.bySource.get(nodeId) ?? [])
        .filter((edge) => !meta.removedEdges.has(edge.id))
        .map((edge) => edge.data.target);
      meta.addedEdges.forEach((edge) => {
        if (edge.data.source === nodeId) targets.push(edge.data.target);
      });
      return targets;
    };
    const startIds = new Set(workflowStartIds);
    meta.nodeChanges.forEach(({ before, after }, nodeId) => {
      if (before?.data.flowNodeType === FlowNodeTypeEnum.workflowStart) startIds.delete(nodeId);
      if (after?.data.flowNodeType === FlowNodeTypeEnum.workflowStart) startIds.add(nodeId);
    });

    startIds.forEach((startNodeId) => {
      const startNode = getWorkingNode(startNodeId, meta);
      if (!startNode) return;
      const visited = new Set<string>();
      const queue = getWorkingTargets(startNode.data.nodeId);
      while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId || visited.has(nodeId)) continue;
        visited.add(nodeId);
        const target = getWorkingNode(nodeId, meta);
        if (!target) continue;

        const nextInputs = applyWorkflowStartInputAutoFill({
          inputs: target.data.inputs,
          workflowStartNodeId: startNode.data.nodeId,
          workflowStartOutputs: startNode.data.outputs
        });
        if (!valuesEqual(target.data.inputs, nextInputs)) {
          const nextData = { ...target.data, inputs: nextInputs };
          const previousData = target.data;
          const targetIndex = getWorkingNodeIndex({ working, nodeId, meta });
          const nextRecord = { data: nextData, view: target.view };
          working.nodes = working.nodes.slice();
          working.nodes[targetIndex] = nextRecord;
          updateReferenceGraphNode({
            graph: referenceGraph,
            before: previousData,
            after: nextData
          });
          recordNodeChange({
            meta,
            nodeId,
            before: { data: previousData, view: target.view },
            after: nextRecord,
            afterIndex: targetIndex
          });
          collectNodeFieldChanges({
            changedFieldIds: meta.changedFieldIds,
            before: previousData,
            after: nextData
          });
        }
        queue.push(...getWorkingTargets(nodeId));
      }
    });
  };

  /** 结构边变化会影响目标及其下游的可达性，按两版边集合取保守闭包。 */
  const addAffectedStructure = (meta: MutationMeta) => {
    if (!meta.structureChanged) return;
    const seedNodeIds = new Set<string>();
    meta.nodeChanges.forEach(({ before, after }, nodeId) => {
      if (!before || !after || before.data.parentNodeId !== after.data.parentNodeId) {
        if (after) seedNodeIds.add(nodeId);
        return;
      }
      if (
        !valuesEqual(before.data.outputs, after.data.outputs) ||
        before.data.flowNodeType !== after.data.flowNodeType
      ) {
        seedNodeIds.add(nodeId);
      }
    });
    meta.addedEdges.forEach((edge) => {
      seedNodeIds.add(edge.data.target);
    });
    meta.removedEdges.forEach((edge) => {
      seedNodeIds.add(edge.data.target);
    });

    const queue = [...seedNodeIds];
    const visited = new Set<string>();
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const nodeId = queue[queueIndex++];
      if (!nodeId || visited.has(nodeId)) continue;
      visited.add(nodeId);
      meta.affectedNodeIds.add(nodeId);
      nodeIndex
        .get(nodeId)
        ?.record.data.inputs.forEach((input) =>
          addFieldIdentity(
            meta.affectedFieldIds,
            getFieldIdentity({ nodeId, field: input, kind: 'input' })
          )
        );
      queue.push(...(graphIndex.bySource.get(nodeId) ?? []).map((edge) => edge.data.target));
    }
  };

  const allocateEdgeId = () => `edge-${nextEdgeId++}`;
  const getNextEdgeId = () => nextEdgeId;
  const setNextEdgeId = (value: number) => {
    nextEdgeId = value;
  };

  /** 在隔离 working document 上应用一个语义命令；异常只会丢弃本次 transaction。 */
  const reduceCommand = (
    { working, meta, referenceGraph }: TransactionContext,
    command: SemanticCommand
  ): void => {
    switch (command.type) {
      case 'addNode': {
        const parsedNode = StoreNodeItemTypeSchema.parse(command.node);
        if (getWorkingNode(parsedNode.nodeId, meta)) {
          throw getError('duplicate_node', `Node already exists: ${parsedNode.nodeId}`);
        }
        const nextRecord = splitNode(parsedNode, hasForbidDelete(command.node));
        validateNodePlacement({ working, node: nextRecord });
        working.nodes = [...working.nodes, nextRecord];
        updateReferenceGraphNode({ graph: referenceGraph, after: nextRecord.data });
        recordNodeChange({
          meta,
          nodeId: parsedNode.nodeId,
          after: nextRecord,
          afterIndex: working.nodes.length - 1
        });
        collectNodeFieldChanges({ changedFieldIds: meta.changedFieldIds, after: nextRecord.data });
        meta.structureChanged = true;
        return;
      }
      case 'replaceNode': {
        const parsedNode = StoreNodeItemTypeSchema.parse(command.node);
        const index = getWorkingNodeIndex({ working, nodeId: command.nodeId, meta });
        if (index < 0) throw getError('not_found', `Node not found: ${command.nodeId}`);
        if (parsedNode.nodeId !== command.nodeId) {
          throw getError('invalid_command', 'replaceNode cannot change nodeId');
        }
        if (parsedNode.parentNodeId !== working.nodes[index].data.parentNodeId) {
          throw getError('invalid_placement', 'Use attachToContainer to change node placement');
        }
        working.nodes = working.nodes.slice();
        const current = working.nodes[index];
        const nextNode = splitNode(
          parsedNode,
          current.forbidDelete === true || hasForbidDelete(command.node)
        );
        validateNodePlacement({ working, node: nextNode, excludeNodeId: command.nodeId });
        working.nodes[index] = {
          data: nextNode.data,
          view: valuesEqual(current.view, nextNode.view) ? current.view : nextNode.view,
          ...(nextNode.forbidDelete ? { forbidDelete: true } : {})
        };
        updateReferenceGraphNode({
          graph: referenceGraph,
          before: current.data,
          after: nextNode.data
        });
        if (
          !valuesEqual(current.data, nextNode.data) ||
          !valuesEqual(current.view, working.nodes[index].view)
        ) {
          recordNodeChange({
            meta,
            nodeId: command.nodeId,
            before: current,
            after: working.nodes[index],
            afterIndex: index
          });
        }
        collectNodeFieldChanges({
          changedFieldIds: meta.changedFieldIds,
          before: current.data,
          after: nextNode.data
        });
        if (!valuesEqual(current.view, nextNode.view)) meta.changedNodeViewIds.add(command.nodeId);
        return;
      }
      case 'updateNode': {
        const index = getWorkingNodeIndex({ working, nodeId: command.nodeId, meta });
        if (index < 0) throw getError('not_found', `Node not found: ${command.nodeId}`);
        const current = working.nodes[index];
        working.nodes = working.nodes.slice();
        const nextData = StoreNodeItemTypeSchema.parse({
          ...cloneValue(current.data),
          ...cloneValue(command.patch),
          ...(current.view.position ? { position: current.view.position } : {}),
          ...(current.view.isFolded !== undefined ? { isFolded: current.view.isFolded } : {})
        });
        if (nextData.nodeId !== command.nodeId)
          throw getError('invalid_command', 'updateNode cannot change nodeId');
        if (nextData.parentNodeId !== current.data.parentNodeId) {
          throw getError('invalid_placement', 'Use attachToContainer to change node placement');
        }
        const stableData = {
          ...nextData,
          inputs: reuseEqualItems(current.data.inputs, nextData.inputs),
          outputs: reuseEqualItems(current.data.outputs, nextData.outputs)
        };
        const { position, isFolded, inputs: _inputs, outputs: _outputs, ...data } = stableData;
        const nextView = mergeNodeView({ current: current.view, position, isFolded });
        working.nodes[index] = {
          data: { ...data, inputs: stableData.inputs, outputs: stableData.outputs },
          view: valuesEqual(current.view, nextView) ? current.view : nextView,
          ...(current.forbidDelete ? { forbidDelete: true } : {})
        };
        const nextRecord = working.nodes[index];
        if (getPlacementError({ working, node: nextRecord, parentId: nextData.parentNodeId })) {
          throw getError('invalid_placement', 'Node placement is not allowed');
        }
        updateReferenceGraphNode({
          graph: referenceGraph,
          before: current.data,
          after: nextRecord.data
        });
        if (
          !valuesEqual(current.data, nextRecord.data) ||
          !valuesEqual(current.view, nextRecord.view)
        ) {
          recordNodeChange({
            meta,
            nodeId: command.nodeId,
            before: current,
            after: nextRecord,
            afterIndex: index
          });
        }
        collectNodeFieldChanges({
          changedFieldIds: meta.changedFieldIds,
          before: current.data,
          after: nextRecord.data
        });
        if (!valuesEqual(current.view, nextRecord.view))
          meta.changedNodeViewIds.add(command.nodeId);
        return;
      }
      case 'updateField': {
        const index = getWorkingNodeIndex({ working, nodeId: command.nodeId, meta });
        if (index < 0) throw getError('not_found', `Node not found: ${command.nodeId}`);
        const current = working.nodes[index];
        const inputIndex =
          command.kind !== 'output'
            ? current.data.inputs.findIndex((item) => item.key === command.fieldKey)
            : -1;
        const outputIndex =
          command.kind !== 'input'
            ? current.data.outputs.findIndex((item) => item.id === command.fieldKey)
            : -1;
        if (inputIndex < 0 && outputIndex < 0)
          throw getError('not_found', `Field not found: ${command.nodeId}.${command.fieldKey}`);
        const data = { ...current.data };
        if (inputIndex >= 0) {
          data.inputs = current.data.inputs.map((item, itemIndex) =>
            itemIndex === inputIndex ? { ...item, value: cloneValue(command.value) } : item
          );
        } else {
          data.outputs = current.data.outputs.map((item, itemIndex) =>
            itemIndex === outputIndex ? { ...item, value: cloneValue(command.value) } : item
          );
        }
        working.nodes = working.nodes.slice();
        working.nodes[index] = { data, view: current.view };
        updateReferenceGraphNode({ graph: referenceGraph, before: current.data, after: data });
        if (!valuesEqual(current.data, data)) {
          recordNodeChange({
            meta,
            nodeId: command.nodeId,
            before: current,
            after: working.nodes[index],
            afterIndex: index
          });
        }
        collectNodeFieldChanges({
          changedFieldIds: meta.changedFieldIds,
          before: current.data,
          after: data
        });
        return;
      }
      case 'removeNodes': {
        const rootIds = new Set(command.nodeIds);
        const missing = command.nodeIds.find((nodeId) => !getWorkingNode(nodeId, meta));
        if (missing) throw getError('not_found', `Node not found: ${missing}`);
        const descendantIds = getDescendantNodeIds(rootIds);
        const deletedIds = new Set([...rootIds, ...descendantIds]);
        const parentDeleted = (node: NodeRecord) =>
          node.data.parentNodeId !== undefined && deletedIds.has(node.data.parentNodeId);

        working.nodes.forEach((node) => {
          if (
            deletedIds.has(node.data.nodeId) &&
            isForbiddenDeleteNode(node) &&
            !parentDeleted(node)
          ) {
            throw getError('invalid_command', `Node cannot be deleted: ${node.data.nodeId}`);
          }
          if (
            deletedIds.has(node.data.nodeId) &&
            node.data.flowNodeType === FlowNodeTypeEnum.loopRunBreak &&
            !parentDeleted(node)
          ) {
            const parent = working.nodes.find(({ data }) => data.nodeId === node.data.parentNodeId);
            const loopMode = parent?.data.inputs.find(
              (input) => input.key === NodeInputKeyEnum.loopRunMode
            )?.value;
            const remainingBreak = working.nodes.some(
              ({ data }) =>
                data.parentNodeId === node.data.parentNodeId &&
                data.flowNodeType === FlowNodeTypeEnum.loopRunBreak &&
                !deletedIds.has(data.nodeId)
            );
            if (
              parent?.data.flowNodeType === FlowNodeTypeEnum.loopRun &&
              loopMode === 'conditional' &&
              !remainingBreak
            ) {
              throw getError('invalid_command', 'Conditional loop must retain a break node');
            }
          }
        });

        working.nodes.forEach((node, index) => {
          if (!deletedIds.has(node.data.nodeId)) return;
          updateReferenceGraphNode({ graph: referenceGraph, before: node.data });
          recordNodeChange({
            meta,
            nodeId: node.data.nodeId,
            before: node,
            afterIndex: index
          });
          collectNodeFieldChanges({
            changedFieldIds: meta.changedFieldIds,
            before: node.data
          });
        });
        working.nodes = working.nodes.filter((node) => !deletedIds.has(node.data.nodeId));
        const removedEdges = working.edges.filter(
          (edge) => deletedIds.has(edge.data.source) || deletedIds.has(edge.data.target)
        );
        removedEdges.forEach((edge) => {
          recordEdgeChange({ meta, edge, kind: 'remove' });
        });
        working.edges = working.edges.filter(
          (edge) => !deletedIds.has(edge.data.source) && !deletedIds.has(edge.data.target)
        );
        meta.structureChanged = true;
        meta.deletedEdgeCount += removedEdges.length;
        return;
      }
      case 'connectEdge': {
        const edge = StoreEdgeItemTypeSchema.parse(command.edge);
        if (!getWorkingNode(edge.source, meta) || !getWorkingNode(edge.target, meta)) {
          throw getError('invalid_edge', 'Cannot connect an edge to a missing node');
        }
        if (!isEdgeConnectionAllowed(working, edge, undefined, meta)) {
          throw getError('invalid_edge', 'Edge connection is not allowed');
        }
        if (working.edges.some(({ data }) => valuesEqual(data, edge))) {
          throw getError('invalid_edge', 'Identical edge already exists');
        }
        const edgeRecord = { id: allocateEdgeId(), data: cloneValue(edge) };
        working.edges = [...working.edges, edgeRecord];
        recordEdgeChange({ meta, edge: edgeRecord, kind: 'add' });
        meta.structureChanged = true;
        return;
      }
      case 'disconnectEdge': {
        let index = command.edgeId
          ? working.edges.findIndex((item) => item.id === command.edgeId)
          : command.index;
        if (index === undefined && command.edge) {
          const edge = StoreEdgeItemTypeSchema.parse(command.edge);
          index = working.edges.findIndex((item) => valuesEqual(item.data, edge));
        }
        if (index === undefined || index < 0 || index >= working.edges.length) {
          throw getError('not_found', 'Edge not found');
        }
        const edge = working.edges[index];
        working.edges = working.edges.slice();
        working.edges.splice(index, 1);
        recordEdgeChange({ meta, edge, kind: 'remove' });
        meta.structureChanged = true;
        return;
      }
      case 'attachToContainer': {
        const nodeIndex = getWorkingNodeIndex({ working, nodeId: command.nodeId, meta });
        if (nodeIndex < 0) throw getError('not_found', `Node not found: ${command.nodeId}`);
        const container = getWorkingNode(command.containerId, meta);
        if (!container) throw getError('not_found', `Node not found: ${command.containerId}`);

        const node = working.nodes[nodeIndex];
        if (node.data.parentNodeId !== undefined) {
          throw getError('invalid_placement', 'Only a top-level node can be attached');
        }
        if (!isNestedParentNodeType(container.data.flowNodeType)) {
          throw getError('invalid_placement', 'Attach target must be a container');
        }
        if (
          command.nodeId === command.containerId ||
          getDescendantNodeIds(new Set([command.nodeId])).has(command.containerId)
        ) {
          throw getError(
            'invalid_placement',
            'A node cannot be attached to itself or its descendant'
          );
        }
        if (getPlacementError({ working, node, parentId: command.containerId })) {
          throw getError('invalid_placement', 'Node placement is not allowed');
        }

        const previouslyAllowedEdges = new Map(
          working.edges
            .filter(({ data }) => data.source === command.nodeId || data.target === command.nodeId)
            .map((edge) => [edge.id, isEdgeConnectionAllowed(working, edge.data, edge.id, meta)])
        );
        working.nodes = working.nodes.slice();
        const nextData = { ...node.data, parentNodeId: command.containerId };
        working.nodes[nodeIndex] = { data: nextData, view: node.view };
        recordNodeChange({
          meta,
          nodeId: command.nodeId,
          before: node,
          after: working.nodes[nodeIndex],
          afterIndex: nodeIndex
        });
        meta.structureChanged = true;

        const removedEdges = working.edges.filter(({ id, data }) => {
          if (!previouslyAllowedEdges.get(id)) return false;
          return !isEdgeConnectionAllowed(working, data, id, meta);
        });
        if (removedEdges.length > 0) {
          removedEdges.forEach((edge) => {
            recordEdgeChange({ meta, edge, kind: 'remove' });
          });
          working.edges = working.edges.filter(
            ({ id }) => !removedEdges.some((edge) => edge.id === id)
          );
          meta.deletedEdgeCount += removedEdges.length;
        }
        meta.reportsDeletedEdgeCount = true;
        return;
      }
      case 'updateChatConfig': {
        const nextChatConfig = AppChatConfigTypeSchema.parse(cloneValue(command.chatConfig));
        meta.chatConfigChanged = !valuesEqual(working.chatConfig, nextChatConfig);
        working.chatConfig = nextChatConfig;
        return;
      }
      case 'replaceDocument': {
        if (
          meta.changedNodeIds.size > 0 ||
          meta.changedNodeViewIds.size > 0 ||
          meta.changedFieldIds.size > 0 ||
          meta.changedEdgeIds.size > 0 ||
          meta.chatConfigChanged
        ) {
          throw getError(
            'invalid_command',
            'replaceDocument must be the only command in a transaction'
          );
        }
        const rebuilt = buildDocument(command.document, nextEdgeId);
        working.nodes = rebuilt.document.nodes;
        working.edges = rebuilt.document.edges;
        working.chatConfig = rebuilt.document.chatConfig;
        nextEdgeId = rebuilt.nextEdgeId;
        meta.kind = 'replace';
        meta.structureChanged = true;
        return;
      }
    }
  };

  const clear = () => {
    nodeIndex.clear();
    graphIndex.bySource.clear();
    graphIndex.byTarget.clear();
    graphIndex.parentByChild.clear();
    graphIndex.childrenByParent.clear();
    graphIndex.edgeById.clear();
    workflowStartIds.clear();
    document = { nodes: [], edges: [], chatConfig: {} };
  };

  rebuildGraphIndex();
  rebuildWorkflowStartIds();

  return {
    getDocument,
    setDocument,
    getNodeIndex,
    getGraphIndex,
    getNodeById,
    getWorkingNodeIndex,
    isSourceEdgeValid,
    getPlacementError,
    rebuildNodeIndex,
    rebuildGraphIndex,
    updateNodeIndexIncrementally,
    updateGraphIndexIncrementally,
    updateWorkflowStartIndex,
    rebuildWorkflowStartIds,
    commitNodeRecords,
    refreshNodeIndexRecords,
    getNextEdgeId,
    setNextEdgeId,
    reduceCommand,
    applyWorkflowStartAutoFill,
    addAffectedStructure,
    clear
  };
};
