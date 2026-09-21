import type { WorkflowIOValueTypeEnum } from '../../constants';
import { NodeOutputKeyEnum, VARIABLE_NODE_ID } from '../../constants';
import { FlowNodeOutputTypeEnum, FlowNodeTypeEnum } from '../../node/constant';
import { isToolParamInput } from '../../../app/formEdit/utils';
import { nodeInputIsReference } from '../../utils';
import { i18nT } from '../../../../common/i18n/utils';
import {
  filterSelectableWorkflowNodeOutputs,
  getHTTPToolParamOutputs,
  isWorkflowReferenceItem,
  workflowValueTypeIsCompatible
} from '../utils';
import { getWorkflowGlobalVariables } from '../variables';
import type {
  FlowNodeInputItemType,
  FlowNodeOutputItemType,
  ReferenceItemValueType
} from '../../type/io';
import type {
  WorkflowFieldIdentity,
  WorkflowNodeData,
  WorkflowReferenceOption,
  WorkflowReferenceStatus
} from '../types';
import type { AppChatConfigType } from '../../../app/type';
import {
  addFieldIdentity,
  getFieldIdentity,
  getFieldIdentityKey,
  getInputReferences,
  isEmptyValue,
  parseFieldIdentityKey,
  valuesEqual
} from './kernel';
import type {
  DocumentReadApi,
  EdgeRecord,
  FieldStatusCache,
  MutationMeta,
  NodeRecord,
  ReferenceGraph,
  ReferenceSource
} from './types';

/**
 * Reference module：拥有 Reference Graph 与字段引用状态/可选项计算。
 * 只读 Document 的 staged/committed 状态，不写 Document。
 */

const getSourceIdentityKey = ([nodeId, outputId]: ReferenceItemValueType) =>
  `${nodeId}\0${outputId}`;

const createReferenceGraph = (): ReferenceGraph => ({
  consumersBySource: new Map(),
  sourcesByConsumer: new Map(),
  sourceKeysByNode: new Map(),
  depth: 0
});

const getReferenceGraphSet = <
  K extends 'consumersBySource' | 'sourcesByConsumer' | 'sourceKeysByNode'
>(
  graph: ReferenceGraph,
  key: K,
  id: string
): Set<string> | undefined => {
  let current: ReferenceGraph | undefined = graph;
  while (current) {
    if (current[key].has(id)) return current[key].get(id) ?? undefined;
    current = current.parent;
  }
  return undefined;
};

const setReferenceGraphSet = <
  K extends 'consumersBySource' | 'sourcesByConsumer' | 'sourceKeysByNode'
>(
  graph: ReferenceGraph,
  key: K,
  id: string,
  value: Set<string> | undefined
) => {
  graph[key].set(id, value ?? null);
};

/** 建立事务级引用图 overlay；仅复制三张空 mutation map，引用数量不影响命令启动。 */
const forkReferenceGraph = (parent: ReferenceGraph): ReferenceGraph => ({
  parent,
  consumersBySource: new Map(),
  sourcesByConsumer: new Map(),
  sourceKeysByNode: new Map(),
  depth: parent.depth + 1
});

/** 引用图层数达到上限时压平，避免历史事务链让单次读取退化。 */
const compactReferenceGraph = (graph: ReferenceGraph): ReferenceGraph => {
  if (graph.depth < 32) return graph;
  const compacted = createReferenceGraph();
  const apply = <K extends 'consumersBySource' | 'sourcesByConsumer' | 'sourceKeysByNode'>(
    key: K
  ) => {
    const layers: ReferenceGraph[] = [];
    for (let current: ReferenceGraph | undefined = graph; current; current = current.parent) {
      layers.push(current);
    }
    const ids = new Set<string>();
    layers.forEach((layer) => layer[key].forEach((_, id) => ids.add(id)));
    ids.forEach((id) => {
      const value = getReferenceGraphSet(graph, key, id);
      if (value) compacted[key].set(id, new Set(value));
    });
  };
  apply('consumersBySource');
  apply('sourcesByConsumer');
  apply('sourceKeysByNode');
  return compacted;
};

const addReferenceToGraph = (
  graph: ReferenceGraph,
  field: WorkflowFieldIdentity,
  reference: ReferenceItemValueType
) => {
  const fieldKey = getFieldIdentityKey(field);
  const sourceKey = getSourceIdentityKey(reference);
  const consumers = new Set(getReferenceGraphSet(graph, 'consumersBySource', sourceKey));
  consumers.add(fieldKey);
  setReferenceGraphSet(graph, 'consumersBySource', sourceKey, consumers);
  const sources = new Set(getReferenceGraphSet(graph, 'sourcesByConsumer', fieldKey));
  sources.add(sourceKey);
  setReferenceGraphSet(graph, 'sourcesByConsumer', fieldKey, sources);
  const nodeId = sourceKey.slice(0, sourceKey.indexOf('\0'));
  const sourceKeys = new Set(getReferenceGraphSet(graph, 'sourceKeysByNode', nodeId));
  sourceKeys.add(sourceKey);
  setReferenceGraphSet(graph, 'sourceKeysByNode', nodeId, sourceKeys);
};

const removeReferenceFromGraph = (
  graph: ReferenceGraph,
  field: WorkflowFieldIdentity,
  reference: ReferenceItemValueType
) => {
  const fieldKey = getFieldIdentityKey(field);
  const sourceKey = getSourceIdentityKey(reference);
  const consumers = new Set(getReferenceGraphSet(graph, 'consumersBySource', sourceKey));
  consumers?.delete(fieldKey);
  setReferenceGraphSet(
    graph,
    'consumersBySource',
    sourceKey,
    consumers.size ? consumers : undefined
  );
  const sources = new Set(getReferenceGraphSet(graph, 'sourcesByConsumer', fieldKey));
  sources?.delete(sourceKey);
  setReferenceGraphSet(graph, 'sourcesByConsumer', fieldKey, sources.size ? sources : undefined);
  if (consumers.size === 0) {
    const nodeId = sourceKey.slice(0, sourceKey.indexOf('\0'));
    const sourceKeys = new Set(getReferenceGraphSet(graph, 'sourceKeysByNode', nodeId));
    sourceKeys.delete(sourceKey);
    setReferenceGraphSet(
      graph,
      'sourceKeysByNode',
      nodeId,
      sourceKeys.size ? sourceKeys : undefined
    );
  }
};

/** Document reducer 在改写 Node Data 时同步 staged 引用图；before/after 都可选。 */
export const updateReferenceGraphNode = ({
  graph,
  before,
  after
}: {
  graph: ReferenceGraph;
  before?: WorkflowNodeData;
  after?: WorkflowNodeData;
}) => {
  if (before) {
    before.inputs.forEach((input) => {
      const field = getFieldIdentity({ nodeId: before.nodeId, field: input, kind: 'input' });
      getInputReferences(input).forEach((reference) =>
        removeReferenceFromGraph(graph, field, reference)
      );
    });
  }
  if (after) {
    after.inputs.forEach((input) => {
      const field = getFieldIdentity({ nodeId: after.nodeId, field: input, kind: 'input' });
      getInputReferences(input).forEach((reference) =>
        addReferenceToGraph(graph, field, reference)
      );
    });
  }
};

const buildReferenceGraph = (nodes: NodeRecord[]): ReferenceGraph => {
  const graph = createReferenceGraph();
  nodes.forEach(({ data }) => updateReferenceGraphNode({ graph, after: data }));
  return graph;
};

const hasMalformedReferenceArray = (value: unknown): boolean => {
  if (!Array.isArray(value) || isWorkflowReferenceItem(value) || !value.some(Array.isArray)) {
    return false;
  }
  return value.some((item) => !isWorkflowReferenceItem(item));
};

/**
 * 按稳定引用身份读取当前来源展示元数据；来源被删除时由实时状态报告 invalid_reference。
 */
const getReferenceSource = ({
  reference,
  nodes,
  chatConfig,
  edges
}: {
  reference: ReferenceItemValueType;
  nodes: NodeRecord[];
  chatConfig: AppChatConfigType;
  edges: EdgeRecord[];
}): ReferenceSource => {
  const [sourceNodeId, outputId] = reference;
  if (sourceNodeId === VARIABLE_NODE_ID) {
    const variable = getWorkflowGlobalVariables({ chatConfig }).find(
      (item) => item.key === outputId
    );
    if (variable) {
      return {
        output: {
          id: variable.key,
          key: variable.key,
          type: FlowNodeOutputTypeEnum.static,
          valueType: variable.valueType,
          label: variable.label
        },
        sourceLabel: i18nT('common:core.module.Variable'),
        outputLabel: variable.label,
        icon: 'core/workflow/template/variable'
      };
    }
  } else {
    const node = nodes.find(({ data }) => data.nodeId === sourceNodeId);
    const isMountedTool = edges.some(
      ({ data }) =>
        data.target === sourceNodeId && data.targetHandle === NodeOutputKeyEnum.selectedTools
    );
    const outputs = [
      ...((node?.data.outputs ?? []) as FlowNodeOutputItemType[]),
      ...(node?.data.flowNodeType === FlowNodeTypeEnum.httpRequest468 && isMountedTool
        ? node.data.inputs.filter(isToolParamInput).map((input) => ({
            id: input.key,
            key: input.key,
            type: FlowNodeOutputTypeEnum.static,
            label: input.label ?? input.key,
            valueType: input.valueType
          }))
        : [])
    ];
    const output = node && outputs.find((item) => item.id === outputId);
    if (output) {
      return {
        output,
        sourceLabel: node.data.name,
        outputLabel: output.label,
        ...(node.data.avatar ? { icon: node.data.avatar } : {})
      };
    }
  }

  return {};
};

/** 把来源节点的下游消费字段并入 affected records；graph 可以是 committed 或 staged 版本。 */
const addAffectedConsumerFields = ({
  meta,
  graph,
  sourceNodeIds,
  fieldIds = meta.affectedFieldIds
}: {
  meta: MutationMeta;
  graph: ReferenceGraph;
  sourceNodeIds: ReadonlySet<string>;
  fieldIds?: Map<string, WorkflowFieldIdentity>;
}) => {
  sourceNodeIds.forEach((nodeId) => {
    const sourceKeys = getReferenceGraphSet(graph, 'sourceKeysByNode', nodeId);
    sourceKeys?.forEach((sourceKey) => {
      getReferenceGraphSet(graph, 'consumersBySource', sourceKey)?.forEach((consumerKey) => {
        const field = parseFieldIdentityKey(consumerKey);
        if (!field) return;
        meta.affectedNodeIds.add(field.nodeId);
        addFieldIdentity(fieldIds, field);
      });
    });
  });
};

/** Create the Workflow Reference module. */
export const createReferenceModule = (document: DocumentReadApi) => {
  let referenceGraph = buildReferenceGraph(document.getDocument().nodes);
  const fieldStatusCache = new Map<string, FieldStatusCache>();

  const getGraph = () => referenceGraph;
  const forkGraph = () => forkReferenceGraph(referenceGraph);
  const commitStagedGraph = (graph: ReferenceGraph) => {
    referenceGraph = compactReferenceGraph(graph);
  };
  const rebuildGraph = () => {
    referenceGraph = buildReferenceGraph(document.getDocument().nodes);
  };

  /**
   * 提交本笔事务的 staged Reference Graph，并把领域依赖闭包写回 meta 的 affected records。
   * 调用顺序即事件语义：先按 changed 节点传播，再按引用来源元数据变化传播，最后处理全局变量。
   * 返回值是只用于缓存失效的额外字段身份，它们不进入 affected records。
   */
  const commitTransaction = ({
    meta,
    stagedGraph,
    beforeGraph
  }: {
    meta: MutationMeta;
    stagedGraph: ReferenceGraph;
    beforeGraph: ReferenceGraph;
  }): Map<string, WorkflowFieldIdentity> => {
    commitStagedGraph(stagedGraph);
    const committedGraph = referenceGraph;
    const cacheOnlyFieldIds = new Map<string, WorkflowFieldIdentity>();
    addAffectedConsumerFields({ meta, graph: beforeGraph, sourceNodeIds: meta.changedNodeIds });
    addAffectedConsumerFields({ meta, graph: committedGraph, sourceNodeIds: meta.changedNodeIds });

    const changedSourceNodeIds = new Set<string>();
    meta.nodeChanges.forEach(({ before: previous, after: next }, nodeId) => {
      if (!previous || !next) {
        changedSourceNodeIds.add(nodeId);
        return;
      }
      // HTTP 节点的参数配置同样决定其对外引用来源，所以要额外比较 inputs。
      const sourceMetadataChanged =
        previous.data.name !== next.data.name ||
        previous.data.avatar !== next.data.avatar ||
        previous.data.flowNodeType !== next.data.flowNodeType ||
        previous.data.catchError !== next.data.catchError ||
        !valuesEqual(previous.data.outputs, next.data.outputs) ||
        (previous.data.flowNodeType === FlowNodeTypeEnum.httpRequest468 &&
          !valuesEqual(previous.data.inputs, next.data.inputs));
      if (sourceMetadataChanged) changedSourceNodeIds.add(nodeId);
    });
    [...meta.addedEdges.values(), ...meta.removedEdges.values()].forEach((edge) => {
      if (edge.data.targetHandle === NodeOutputKeyEnum.selectedTools) {
        changedSourceNodeIds.add(edge.data.target);
      }
    });
    addAffectedConsumerFields({
      meta,
      graph: beforeGraph,
      sourceNodeIds: changedSourceNodeIds,
      fieldIds: cacheOnlyFieldIds
    });
    addAffectedConsumerFields({
      meta,
      graph: committedGraph,
      sourceNodeIds: changedSourceNodeIds,
      fieldIds: cacheOnlyFieldIds
    });

    if (meta.chatConfigChanged) {
      const variableSources = new Set([VARIABLE_NODE_ID]);
      addAffectedConsumerFields({ meta, graph: beforeGraph, sourceNodeIds: variableSources });
      addAffectedConsumerFields({ meta, graph: committedGraph, sourceNodeIds: variableSources });
      addAffectedConsumerFields({
        meta,
        graph: beforeGraph,
        sourceNodeIds: variableSources,
        fieldIds: cacheOnlyFieldIds
      });
      addAffectedConsumerFields({
        meta,
        graph: committedGraph,
        sourceNodeIds: variableSources,
        fieldIds: cacheOnlyFieldIds
      });
    }
    return cacheOnlyFieldIds;
  };

  /**
   * 结构变化后需要额外丢弃引用状态缓存的 affected input 字段。
   * 只有真正持有引用的 input 才可能因为结构变化改变状态，其余字段无需失效。
   */
  const getStructureInvalidationFields = (meta: MutationMeta): WorkflowFieldIdentity[] => {
    if (!meta.structureChanged) return [];
    return [...meta.affectedFieldIds.values()].filter((field) => {
      if (field.kind !== 'input') return false;
      const input = document
        .getNodeIndex()
        .get(field.nodeId)
        ?.record.data.inputs.find((item) => item.key === field.key);
      return input ? getInputReferences(input).length > 0 : false;
    });
  };

  /** 从目标节点反向遍历所有上游节点，visited 保证循环图有限终止。 */
  const getIncomingSources = (nodeId: string) => {
    const graphIndex = document.getGraphIndex();
    const sourceIds = new Set<string>();
    const containerNodeIds = [nodeId];
    const visitedParents = new Set<string>(containerNodeIds);
    let parentNodeId = graphIndex.parentByChild.get(nodeId);
    while (parentNodeId && !visitedParents.has(parentNodeId)) {
      containerNodeIds.push(parentNodeId);
      visitedParents.add(parentNodeId);
      parentNodeId = graphIndex.parentByChild.get(parentNodeId);
    }
    const containerNodeIdSet = new Set(containerNodeIds);
    const queue = [...containerNodeIds];
    const searchedTargetIds = new Set<string>();
    while (queue.length > 0) {
      const targetId = queue.shift();
      if (!targetId) continue;
      if (searchedTargetIds.has(targetId)) continue;
      searchedTargetIds.add(targetId);
      if (targetId !== nodeId && containerNodeIdSet.has(targetId)) {
        const container = document.getNodeById(targetId);
        container?.data.inputs.forEach((input) => {
          if (!nodeInputIsReference(input)) return;
          getInputReferences(input).forEach(([sourceId]) => {
            if (sourceId === VARIABLE_NODE_ID || !document.getNodeById(sourceId)) return;
            sourceIds.add(sourceId);
            queue.push(sourceId);
          });
        });
      }
      (graphIndex.byTarget.get(targetId) ?? []).forEach((edge) => {
        if (sourceIds.has(edge.data.source) || !document.isSourceEdgeValid(edge)) return;
        sourceIds.add(edge.data.source);
        queue.push(edge.data.source);
      });
    }
    return sourceIds;
  };

  /** 计算一个引用相对目标节点的状态；循环图通过 GraphIndex 的 visited 集合自然终止。 */
  const getReferenceStatus = ({
    reference,
    targetType,
    targetNodeId
  }: {
    reference: ReferenceItemValueType;
    targetType?: WorkflowIOValueTypeEnum;
    targetNodeId: string;
  }): WorkflowReferenceStatus => {
    const current = document.getDocument();
    const [sourceNodeId] = reference;
    const source = getReferenceSource({
      reference,
      nodes: current.nodes,
      chatConfig: current.chatConfig,
      edges: current.edges
    });
    const sourceMetadata = {
      ...(source.sourceLabel ? { sourceLabel: source.sourceLabel } : {}),
      ...(source.outputLabel ? { outputLabel: source.outputLabel } : {}),
      ...(source.icon ? { icon: source.icon } : {})
    };
    if (sourceNodeId === VARIABLE_NODE_ID) {
      if (!source.output) return { code: 'invalid_reference', reference, ...sourceMetadata };
      return workflowValueTypeIsCompatible(source.output.valueType, targetType)
        ? { code: 'valid', sourceType: source.output.valueType, reference, ...sourceMetadata }
        : {
            code: 'invalid_reference_type',
            sourceType: source.output.valueType,
            reference,
            ...sourceMetadata
          };
    }

    const sourceNode = document.getNodeById(sourceNodeId);
    const sourceOutput = source.output;
    if (!sourceNode || !sourceOutput)
      return { code: 'invalid_reference', reference, ...sourceMetadata };
    const selectableOutputs = filterSelectableWorkflowNodeOutputs({
      outputs: [sourceOutput],
      catchError: sourceNode.data.catchError
    });
    if (selectableOutputs.length === 0)
      return { code: 'invalid_reference', reference, ...sourceMetadata };
    if (!getIncomingSources(targetNodeId).has(sourceNodeId)) {
      return {
        code: 'unreachable_reference',
        sourceType: sourceOutput.valueType,
        reference,
        ...sourceMetadata
      };
    }
    return workflowValueTypeIsCompatible(sourceOutput.valueType, targetType)
      ? { code: 'valid', sourceType: sourceOutput.valueType, reference, ...sourceMetadata }
      : {
          code: 'invalid_reference_type',
          sourceType: sourceOutput.valueType,
          reference,
          ...sourceMetadata
        };
  };

  /** 惰性计算输入字段引用状态；普通非 reference 输入不会进入诊断。 */
  const getFieldStatuses = (
    nodeId: string,
    field: FlowNodeInputItemType | FlowNodeOutputItemType
  ): WorkflowReferenceStatus[] => {
    if (!('renderTypeList' in field)) return [];
    const cacheKey = getFieldIdentityKey({ nodeId, key: field.key, kind: 'input' });
    const cached = fieldStatusCache.get(cacheKey);
    if (cached?.field === field) return cached.statuses;

    const value = field.value ?? field.defaultValue;
    if (isEmptyValue(value)) {
      fieldStatusCache.set(cacheKey, { field, statuses: [] });
      return [];
    }
    const references = getInputReferences(field);
    if (!nodeInputIsReference(field) && references.length === 0) {
      fieldStatusCache.set(cacheKey, { field, statuses: [] });
      return [];
    }
    const targetType = 'renderTypeList' in field ? field.valueType : undefined;
    const statuses = references.map((reference) =>
      getReferenceStatus({ reference, targetType, targetNodeId: nodeId })
    );
    const result = hasMalformedReferenceArray(value)
      ? [{ code: 'invalid_reference' as const }, ...statuses]
      : statuses.length > 0
        ? statuses
        : [{ code: 'invalid_reference' as const }];
    fieldStatusCache.set(cacheKey, { field, statuses: result });
    return result;
  };

  /** 返回当前字段可选的实时来源；失效引用不会重新出现在选择列表。 */
  const getReferenceOptions = (
    nodeId: string,
    input: FlowNodeInputItemType
  ): WorkflowReferenceOption[] => {
    const nodeIndex = document.getNodeIndex();
    const graphIndex = document.getGraphIndex();
    const sourceIds = getIncomingSources(nodeId);
    const options: WorkflowReferenceOption[] = [];

    [...sourceIds]
      .sort(
        (left, right) =>
          (nodeIndex.get(left)?.index ?? Number.MAX_SAFE_INTEGER) -
          (nodeIndex.get(right)?.index ?? Number.MAX_SAFE_INTEGER)
      )
      .forEach((sourceNodeId) => {
        const sourceNode = nodeIndex.get(sourceNodeId)?.record;
        if (!sourceNode) return;
        const isMountedTool = (graphIndex.byTarget.get(sourceNodeId) ?? []).some(
          ({ data }) => data.targetHandle === NodeOutputKeyEnum.selectedTools
        );
        filterSelectableWorkflowNodeOutputs({
          outputs: [
            ...sourceNode.data.outputs,
            ...(isMountedTool
              ? getHTTPToolParamOutputs({ ...sourceNode.data, id: sourceNode.data.nodeId })
              : [])
          ],
          valueType: input.valueType,
          catchError: sourceNode.data.catchError
        }).forEach((output) => {
          options.push({
            reference: [sourceNodeId, output.id],
            sourceType: output.valueType,
            sourceLabel: sourceNode.data.name,
            outputLabel: output.label ?? output.key,
            ...(sourceNode.data.avatar ? { icon: sourceNode.data.avatar } : {})
          });
        });
      });

    getWorkflowGlobalVariables({ chatConfig: document.getDocument().chatConfig }).forEach(
      (variable) => {
        if (!workflowValueTypeIsCompatible(variable.valueType, input.valueType)) return;
        options.push({
          reference: [VARIABLE_NODE_ID, variable.key],
          sourceType: variable.valueType,
          sourceLabel: i18nT('common:core.module.Variable'),
          outputLabel: variable.label,
          icon: 'core/workflow/template/variable'
        });
      }
    );

    return options;
  };

  /** 事务提交后按字段身份丢弃缓存，避免 scoped snapshot 复用过期状态。 */
  const invalidateFieldStatuses = (fields: Iterable<WorkflowFieldIdentity>) => {
    for (const field of fields) {
      fieldStatusCache.delete(getFieldIdentityKey(field));
    }
  };

  /** 全量重建后按字段对象身份清理缓存；字段对象已替换的条目不再有效。 */
  const pruneFieldStatusCache = () => {
    fieldStatusCache.forEach((cached, cacheKey) => {
      const identity = parseFieldIdentityKey(cacheKey);
      const field =
        identity?.kind === 'input'
          ? document
              .getNodeById(identity.nodeId)
              ?.data.inputs.find((item) => item.key === identity.key)
          : undefined;
      if (!field || field !== cached.field) fieldStatusCache.delete(cacheKey);
    });
  };

  const clearFieldStatusCache = () => fieldStatusCache.clear();

  const clear = () => {
    fieldStatusCache.clear();
    referenceGraph = createReferenceGraph();
  };

  return {
    getGraph,
    forkGraph,
    rebuildGraph,
    commitTransaction,
    getStructureInvalidationFields,
    getFieldStatuses,
    getReferenceOptions,
    invalidateFieldStatuses,
    pruneFieldStatusCache,
    clearFieldStatusCache,
    clear
  };
};
