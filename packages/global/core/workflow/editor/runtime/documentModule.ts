import { NodeOutputKeyEnum } from '../../constants';
import { stripCanvasSizeInputs } from '../../migration/migrate';
import { FlowNodeTypeEnum, isNestedParentNodeType } from '../../node/constant';
import { StoreEdgeItemTypeSchema, type StoreEdgeItemType } from '../../type/edge';
import { StoreNodeItemTypeSchema } from '../../type/node';
import { AppChatConfigTypeSchema } from '../../../app/type';
import { isNodeConnectionAllowed } from '../../template/context';
import { moduleTemplatesFlat } from '../../template/constants';
import { isWorkflowEdgeSourceHandleValid } from '../utils';
import { applyWorkflowStartInputAutoFill } from '../startAutoFill';
import type { RuntimeEdgeId } from '../types';
import { addFieldIdentity, cloneValue, getError, getFieldIdentity, valuesEqual } from './kernel';
import {
  deleteStagedNodeView,
  getStagedNodeView,
  mergeNodeView,
  replaceStagedNodeViews,
  setStagedNodeView
} from './nodeViewModule';
import { updateReferenceGraphNode } from './referenceModule';
import type {
  CanonicalResult,
  EdgeRecord,
  GraphIndex,
  IndexedNode,
  MutationMeta,
  RuntimeDocument,
  SemanticCommand,
  TransactionContext
} from './types';
import {
  applyGraphIndexChanges,
  applyPersistedDerivedFields,
  applyWorkflowStartChanges,
  buildDocument,
  buildGraphIndex,
  buildNodeIndex,
  collectDescendantNodeIds,
  collectNodeFieldChanges,
  collectWorkflowStartIds,
  commitNodeRecordUpdate,
  getPlacementError,
  hasForbidDelete,
  isContainerArrayInputKey,
  recordEdgeChange,
  recordNodeChange,
  reuseEqualItems,
  splitNode,
  validateNodeDeletion,
  validateNodePlacement
} from './documentRules';

/**
 * Document module：拥有 Node Data、edges、chatConfig、Runtime Edge ID、node/graph 索引，
 * 以及语义命令的校验与 reduce。无状态规则在 ./documentRules，本文件只保留有状态工厂。
 * 节点视图不在这里：Document 只持有语义记录，视图存储归 Node View module。
 */

/** Create the Workflow Document module；入参是入站边界已经组装好的初始文档与视图。 */
export const createDocumentModule = (initial: CanonicalResult) => {
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

  /** 重建私有邻接索引。 */
  const rebuildGraphIndex = () => {
    graphIndex = buildGraphIndex(document.nodes, document.edges);
  };

  /** 普通命令只提交局部图变化；replace 与 undo/redo 才走全量重建。 */
  const updateGraphIndexIncrementally = (meta: MutationMeta) =>
    applyGraphIndexChanges(graphIndex, meta);

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

  const updateWorkflowStartIndex = (meta: MutationMeta) =>
    applyWorkflowStartChanges(workflowStartIds, meta);

  const rebuildWorkflowStartIds = () => {
    workflowStartIds = collectWorkflowStartIds(document.nodes);
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

  const getDescendantNodeIds = (rootIds: ReadonlySet<string>) =>
    collectDescendantNodeIds(graphIndex.childrenByParent, rootIds);

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
          // 保留原记录上的运行时元数据（forbidDelete），只替换语义数据。
          const nextRecord = { ...target, data: nextData };
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
            before: target,
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
    { working, views, meta, referenceGraph }: TransactionContext,
    command: SemanticCommand
  ): void => {
    switch (command.type) {
      case 'addNode': {
        const parsedNode = StoreNodeItemTypeSchema.parse(command.node);
        if (getWorkingNode(parsedNode.nodeId, meta)) {
          throw getError('duplicate_node', `Node already exists: ${parsedNode.nodeId}`);
        }
        const { record, view } = splitNode(parsedNode, hasForbidDelete(command.node));
        validateNodePlacement({ working, node: record });
        working.nodes = [...working.nodes, record];
        setStagedNodeView({ meta, views, nodeId: record.data.nodeId, view });
        updateReferenceGraphNode({ graph: referenceGraph, after: record.data });
        recordNodeChange({
          meta,
          nodeId: parsedNode.nodeId,
          after: record,
          afterIndex: working.nodes.length - 1
        });
        collectNodeFieldChanges({ changedFieldIds: meta.changedFieldIds, after: record.data });
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
        const { record: nextNode, view } = splitNode(
          parsedNode,
          current.forbidDelete === true || hasForbidDelete(command.node)
        );
        validateNodePlacement({ working, node: nextNode, excludeNodeId: command.nodeId });
        working.nodes[index] = nextNode;
        setStagedNodeView({ meta, views, nodeId: command.nodeId, view });
        commitNodeRecordUpdate({
          meta,
          referenceGraph,
          nodeId: command.nodeId,
          index,
          before: current,
          after: nextNode
        });
        return;
      }
      case 'updateNode': {
        const index = getWorkingNodeIndex({ working, nodeId: command.nodeId, meta });
        if (index < 0) throw getError('not_found', `Node not found: ${command.nodeId}`);
        const current = working.nodes[index];
        const currentView = getStagedNodeView(views, command.nodeId);
        working.nodes = working.nodes.slice();
        // patch 里的 position/isFolded 会被当前视图覆盖：几何只能走 commitGeometry。
        const nextData = StoreNodeItemTypeSchema.parse({
          ...cloneValue(current.data),
          ...cloneValue(command.patch),
          ...(currentView.position ? { position: currentView.position } : {}),
          ...(currentView.isFolded !== undefined ? { isFolded: currentView.isFolded } : {})
        });
        if (nextData.nodeId !== command.nodeId)
          throw getError('invalid_command', 'updateNode cannot change nodeId');
        if (nextData.parentNodeId !== current.data.parentNodeId) {
          throw getError('invalid_placement', 'Use attachToContainer to change node placement');
        }
        const stableData = {
          ...nextData,
          inputs: stripCanvasSizeInputs(reuseEqualItems(current.data.inputs, nextData.inputs)),
          outputs: reuseEqualItems(current.data.outputs, nextData.outputs)
        };
        const { position, isFolded, inputs: _inputs, outputs: _outputs, ...data } = stableData;
        working.nodes[index] = {
          data: { ...data, inputs: stableData.inputs, outputs: stableData.outputs },
          ...(current.forbidDelete ? { forbidDelete: true } : {})
        };
        const nextRecord = working.nodes[index];
        if (getPlacementError({ working, node: nextRecord, parentId: nextData.parentNodeId })) {
          throw getError('invalid_placement', 'Node placement is not allowed');
        }
        setStagedNodeView({
          meta,
          views,
          nodeId: command.nodeId,
          view: mergeNodeView({ current: currentView, position, isFolded })
        });
        commitNodeRecordUpdate({
          meta,
          referenceGraph,
          nodeId: command.nodeId,
          index,
          before: current,
          after: nextRecord
        });
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
        working.nodes[index] = { ...current, data };
        commitNodeRecordUpdate({
          meta,
          referenceGraph,
          nodeId: command.nodeId,
          index,
          before: current,
          after: working.nodes[index]
        });
        return;
      }
      case 'removeNodes': {
        const rootIds = new Set(command.nodeIds);
        const missing = command.nodeIds.find((nodeId) => !getWorkingNode(nodeId, meta));
        if (missing) throw getError('not_found', `Node not found: ${missing}`);
        const descendantIds = getDescendantNodeIds(rootIds);
        const deletedIds = new Set([...rootIds, ...descendantIds]);
        validateNodeDeletion({ nodes: working.nodes, deletedIds });

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
        deletedIds.forEach((nodeId) => deleteStagedNodeView({ meta, views, nodeId }));
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
        working.nodes[nodeIndex] = { ...node, data: nextData };
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
        }
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
          meta.nodeViewChanges.size > 0 ||
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
        replaceStagedNodeViews({ meta, views, next: rebuilt.views });
        nextEdgeId = rebuilt.nextEdgeId;
        meta.kind = 'replace';
        meta.structureChanged = true;
        return;
      }
    }
  };

  /**
   * Persisted Derived Field 维护：容器子节点清单与容器数组输入的值类型由 Document 重算，
   * 作为普通字段参与变化记录与历史，渲染副作用不再写回文档。
   * 只在结构、chatConfig 或数组输入自身变化时执行，其余事务直接跳过，避免每次字段编辑全表扫描。
   */
  const applyDerivedFields = ({ working, meta, referenceGraph }: TransactionContext) => {
    const arrayInputChanged = [...meta.changedFieldIds.values()].some(
      (field) => field.kind === 'input' && isContainerArrayInputKey(field.key)
    );
    if (!meta.structureChanged && !meta.chatConfigChanged && !arrayInputChanged) return;

    const derived = applyPersistedDerivedFields({
      nodes: working.nodes,
      chatConfig: working.chatConfig
    });
    if (derived.changes.length === 0) return;
    working.nodes = derived.nodes;
    derived.changes.forEach(({ index, before, after }) => {
      updateReferenceGraphNode({ graph: referenceGraph, before: before.data, after: after.data });
      recordNodeChange({ meta, nodeId: after.data.nodeId, before, after, afterIndex: index });
      collectNodeFieldChanges({
        changedFieldIds: meta.changedFieldIds,
        before: before.data,
        after: after.data
      });
    });
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
    rebuildNodeIndex,
    rebuildGraphIndex,
    updateNodeIndexIncrementally,
    updateGraphIndexIncrementally,
    updateWorkflowStartIndex,
    rebuildWorkflowStartIds,
    getNextEdgeId,
    setNextEdgeId,
    reduceCommand,
    applyWorkflowStartAutoFill,
    applyDerivedFields,
    addAffectedStructure,
    clear
  };
};
