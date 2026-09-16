import {
  NodeInputKeyEnum,
  NodeOutputKeyEnum,
  VARIABLE_NODE_ID,
  WorkflowIOValueTypeEnum
} from '../constants';
import { CanonicalWorkflowDataSchema, type CanonicalWorkflowData } from '../migration/schema';
import {
  FlowNodeOutputTypeEnum,
  FlowNodeTypeEnum,
  isNestedParentNodeType,
  isNestedChildSystemNodeType
} from '../node/constant';
import type {
  FlowNodeInputItemType,
  FlowNodeOutputItemType,
  ReferenceItemValueType
} from '../type/io';
import { StoreEdgeItemTypeSchema, type StoreEdgeItemType } from '../type/edge';
import {
  StoreNodeItemTypeSchema,
  type StoreNodeItemType,
  type WorkflowCheckIssue
} from '../type/node';
import { AppChatConfigTypeSchema, type AppChatConfigType } from '../../app/type';
import {
  canInputBeAgentGenerated,
  initToolInputTypeByDefaultMode,
  isAgentGeneratedToolInput,
  isToolParamInput
} from '../../app/formEdit/utils';
import { nodeInputIsReference } from '../utils';
import { getWorkflowReferenceItemsFromValue } from './referenceCheck';
import {
  getHTTPToolParamOutputs,
  filterSelectableWorkflowNodeOutputs,
  isEmptyReferenceValue,
  isWorkflowEdgeSourceHandleValid,
  isWorkflowReferenceItem,
  workflowValueTypeIsCompatible
} from './utils';
import { getWorkflowGlobalVariables } from './variables';
import {
  buildNodeTemplateContext,
  getNodeContainerCheckError,
  isNodeConnectionAllowed
} from '../template/context';
import { moduleTemplatesFlat } from '../template/constants';
import { applyWorkflowStartInputAutoFill } from './startAutoFill';
import type {
  DebugSessionSnapshot,
  DebugStartOptions,
  HistorySnapshot,
  NodeViewState,
  WorkflowChange,
  WorkflowCommand,
  WorkflowCommandError,
  WorkflowDispatchResult,
  WorkflowEdgeSnapshot,
  RuntimeEdgeId,
  WorkflowAffectedRecords,
  WorkflowChangedRecords,
  WorkflowFieldIdentity,
  WorkflowFieldQuery,
  WorkflowFieldSnapshot,
  WorkflowNodeData,
  WorkflowNodeSnapshot,
  WorkflowNodeViewSnapshot,
  WorkflowReferenceStatus,
  WorkflowReferenceOption,
  WorkflowRuntimePort,
  WorkflowSnapshot
} from './types';

type NodeRecord = {
  data: WorkflowNodeData;
  view: NodeViewState;
  /** 模板运行时元数据；不能进入 StoreWorkflow 或公开 snapshot。 */
  forbidDelete?: true;
};

type IndexedNode = {
  record: NodeRecord;
  index: number;
};

/** 按节点顺序建立 runtime 私有索引，供 scoped read 与 geometry update 使用。 */
const buildNodeIndex = (nodes: NodeRecord[]): Map<string, IndexedNode> =>
  new Map(nodes.map((node, index) => [node.data.nodeId, { record: node, index }] as const));

type EdgeRecord = {
  id: string;
  data: StoreEdgeItemType;
};

type RuntimeDocument = {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  chatConfig: AppChatConfigType;
};

type ReferenceSource = {
  output?: FlowNodeOutputItemType;
  sourceLabel?: string;
  outputLabel?: string;
  icon?: string;
};

type HistoryEntry =
  | {
      kind: 'delta';
      beforeNodeCount: number;
      afterNodeCount: number;
      nodeChanges: Array<{
        index: number;
        before?: NodeRecord;
        after?: NodeRecord;
      }>;
      beforeEdgeCount: number;
      afterEdgeCount: number;
      edgeChanges: Array<{
        index: number;
        before?: EdgeRecord;
        after?: EdgeRecord;
      }>;
      beforeChatConfig?: AppChatConfigType;
      afterChatConfig?: AppChatConfigType;
      change: WorkflowChange;
    }
  | {
      kind: 'checkpoint';
      before: RuntimeDocument;
      after: RuntimeDocument;
      change: WorkflowChange;
    };

type GraphIndex = {
  bySource: Map<string, EdgeRecord[]>;
  byTarget: Map<string, EdgeRecord[]>;
  parentByChild: Map<string, string>;
  childrenByParent: Map<string, string[]>;
  edgeById: Map<string, EdgeRecord>;
};

type ReferenceGraph = {
  /** 每层只保存本次事务触碰的 key；parent 让普通命令无需复制全图。 */
  parent?: ReferenceGraph;
  consumersBySource: Map<string, Set<string> | null>;
  sourcesByConsumer: Map<string, Set<string> | null>;
  sourceKeysByNode: Map<string, Set<string> | null>;
  depth: number;
};

type MutationMeta = {
  kind: 'semantic' | 'geometry' | 'replace';
  changedNodeIds: Set<string>;
  changedNodeViewIds: Set<string>;
  changedFieldIds: Map<string, WorkflowFieldIdentity>;
  changedEdgeIds: Set<RuntimeEdgeId>;
  affectedNodeIds: Set<string>;
  affectedFieldIds: Map<string, WorkflowFieldIdentity>;
  structureChanged: boolean;
  chatConfigChanged: boolean;
  deletedEdgeCount: number;
  reportsDeletedEdgeCount: boolean;
  nodeChanges: Map<string, { before?: NodeRecord; after?: NodeRecord; afterIndex?: number }>;
  addedEdges: Map<string, EdgeRecord>;
  removedEdges: Map<string, EdgeRecord>;
};

const MAX_CHANGE_LOG = 100;
/** ponytail: keep history bounded; raise only after measuring a real undo-depth need. */
const MAX_HISTORY = 100;
const noUpstreamExemptTypes = new Set<FlowNodeTypeEnum>([
  FlowNodeTypeEnum.workflowStart,
  FlowNodeTypeEnum.pluginInput,
  FlowNodeTypeEnum.nestedStart,
  FlowNodeTypeEnum.loopRunStart,
  FlowNodeTypeEnum.comment,
  FlowNodeTypeEnum.globalVariable,
  FlowNodeTypeEnum.emptyNode
]);
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

/** 判断值是否为可递归复制的普通对象或数组。 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasForbidDelete = (value: unknown): boolean => isObject(value) && value.forbidDelete === true;

/** 复制 fixture 与内部快照；函数值保持引用，兼容节点定义中的运行时回调。 */
const cloneValue = <T>(value: T, seen = new WeakMap<object, unknown>()): T => {
  if (!isObject(value) || typeof value === 'function') return value;
  const previous = seen.get(value);
  if (previous) return previous as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;

  const target = Array.isArray(value) ? [] : {};
  seen.set(value, target);
  Object.keys(value).forEach((key) => {
    (target as Record<string, unknown>)[key] = cloneValue(value[key], seen);
  });
  return target as T;
};

/** 深冻结仅用于对外 snapshot；内部 runtime 记录不会被冻结。 */
const freezeValue = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (!isObject(value) || seen.has(value)) return value;
  seen.add(value);
  Object.keys(value).forEach((key) => freezeValue(value[key], seen));
  return Object.freeze(value);
};

/** 对 fixture 数据执行支持循环引用的结构比较，避免引入深比较依赖。 */
const valuesEqual = (left: unknown, right: unknown): boolean => {
  const seen = new WeakMap<object, object>();
  const compare = (leftValue: unknown, rightValue: unknown): boolean => {
    if (Object.is(leftValue, rightValue)) return true;
    if (!isObject(leftValue) || !isObject(rightValue)) return false;
    if (leftValue instanceof Date || rightValue instanceof Date) {
      return (
        leftValue instanceof Date &&
        rightValue instanceof Date &&
        leftValue.getTime() === rightValue.getTime()
      );
    }
    const paired = seen.get(leftValue);
    if (paired === rightValue) return true;
    seen.set(leftValue, rightValue);
    if (Array.isArray(leftValue) !== Array.isArray(rightValue)) return false;
    const leftKeys = Object.keys(leftValue);
    const rightKeys = Object.keys(rightValue);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightValue, key) &&
        compare(leftValue[key], rightValue[key])
    );
  };
  return compare(left, right);
};

/** 复用未改变的字段对象，维持 scoped field snapshot 的稳定 identity。 */
const reuseEqualItems = <T>(previous: T[], next: T[]): T[] =>
  next.map((item, index) => (valuesEqual(previous[index], item) ? previous[index] : item));

const getError = (code: WorkflowCommandError['code'], message: string): WorkflowCommandError => ({
  code,
  message
});

const isWorkflowCommandErrorCode = (value: unknown): value is WorkflowCommandError['code'] =>
  value === 'disposed' ||
  value === 'invalid_command' ||
  value === 'not_found' ||
  value === 'duplicate_node' ||
  value === 'invalid_edge' ||
  value === 'invalid_placement';

const isWorkflowCommandError = (value: unknown): value is WorkflowCommandError =>
  isObject(value) && isWorkflowCommandErrorCode(value.code) && typeof value.message === 'string';

const workflowCommandTypes = new Set<string>([
  'addNode',
  'replaceNode',
  'updateNode',
  'updateField',
  'removeNodes',
  'connectEdge',
  'disconnectEdge',
  'attachToContainer',
  'updateChatConfig',
  'commitGeometry',
  'replaceDocument'
]);

/** 运行时守卫闭合 command 边界，避免 JS 调用方让未知命令静默成功。 */
const isWorkflowCommand = (value: unknown): value is WorkflowCommand =>
  isObject(value) && typeof value.type === 'string' && workflowCommandTypes.has(value.type);

const isEmptyValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) &&
    (value.length === 0 ||
      (value.length === 2 &&
        ((value[0] === '' && value[1] === '') ||
          (value[0] === undefined && value[1] === undefined)))));

/** 复用工作流引用解析语义；结构字段中的二元 ID 数组属于普通数据。 */
const getInputReferences = (input: FlowNodeInputItemType): ReferenceItemValueType[] => {
  if (input.key === NodeInputKeyEnum.childrenNodeIdList) return [];

  const value = input.value ?? input.defaultValue;
  const canContainCanonicalReferences =
    nodeInputIsReference(input) ||
    input.key === NodeInputKeyEnum.ifElseList ||
    input.key === NodeInputKeyEnum.updateList;
  return getWorkflowReferenceItemsFromValue(value, {
    includeCanonicalReferences: canContainCanonicalReferences
  });
};

/** 为输入 key 与输出 id 生成统一的稳定字段身份。 */
const getFieldIdentity = ({
  nodeId,
  field,
  kind
}:
  | {
      nodeId: string;
      field: FlowNodeInputItemType;
      kind: 'input';
    }
  | {
      nodeId: string;
      field: FlowNodeOutputItemType;
      kind: 'output';
    }): WorkflowFieldIdentity => ({
  nodeId,
  key: kind === 'input' ? field.key : field.id,
  kind
});

const getFieldIdentityKey = ({ nodeId, key, kind }: WorkflowFieldIdentity) =>
  `${nodeId}\0${kind}\0${key}`;

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

const updateReferenceGraphNode = ({
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

const buildReferenceGraph = (document: RuntimeDocument): ReferenceGraph => {
  const graph = createReferenceGraph();
  document.nodes.forEach(({ data }) => updateReferenceGraphNode({ graph, after: data }));
  return graph;
};

const cloneReferenceGraph = forkReferenceGraph;

const addFieldIdentity = (
  fields: Map<string, WorkflowFieldIdentity>,
  field: WorkflowFieldIdentity
) => {
  fields.set(getFieldIdentityKey(field), field);
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

const createMutationMeta = (kind: MutationMeta['kind'] = 'semantic'): MutationMeta => ({
  kind,
  changedNodeIds: new Set(),
  changedNodeViewIds: new Set(),
  changedFieldIds: new Map(),
  changedEdgeIds: new Set(),
  affectedNodeIds: new Set(),
  affectedFieldIds: new Map(),
  structureChanged: false,
  chatConfigChanged: false,
  deletedEdgeCount: 0,
  reportsDeletedEdgeCount: false,
  nodeChanges: new Map(),
  addedEdges: new Map(),
  removedEdges: new Map()
});

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

const parseFieldIdentityKey = (value: string): WorkflowFieldIdentity | undefined => {
  const firstSeparator = value.indexOf('\0');
  const secondSeparator = value.indexOf('\0', firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) return undefined;
  const kind = value.slice(firstSeparator + 1, secondSeparator);
  if (kind !== 'input' && kind !== 'output') return undefined;
  return {
    nodeId: value.slice(0, firstSeparator),
    kind,
    key: value.slice(secondSeparator + 1)
  };
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
        sourceLabel: 'Variable',
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
const buildDocument = (
  input: unknown,
  edgeIdStart = 0
): { document: RuntimeDocument; nextEdgeId: number } => {
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
const documentToCanonical = (document: RuntimeDocument): CanonicalWorkflowData => ({
  nodes: document.nodes.map(({ data, view }) => ({
    ...cloneValue(data),
    ...(view.position ? { position: cloneValue(view.position) } : {}),
    ...(view.isFolded !== undefined ? { isFolded: view.isFolded } : {})
  })),
  edges: document.edges.map((edge) => cloneValue(edge.data)),
  chatConfig: cloneValue(document.chatConfig)
});

/** 保留事务前后浅数组快照；节点记录本身保持共享，避免提交时扫描整个 document。 */
const createHistoryEntry = ({
  before,
  after,
  change
}: {
  before: RuntimeDocument;
  after: RuntimeDocument;
  change: WorkflowChange;
}): HistoryEntry => {
  return { kind: 'checkpoint', before, after, change };
};

/** 用 history delta 还原目标文档，保留未改记录的原始引用。 */
const materializeHistoryDocument = (
  current: RuntimeDocument,
  entry: HistoryEntry,
  direction: 'undo' | 'redo'
): RuntimeDocument => {
  if (entry.kind === 'checkpoint') return direction === 'undo' ? entry.before : entry.after;

  const useBefore = direction === 'undo';
  const nodeChanges = new Map(entry.nodeChanges.map((change) => [change.index, change]));
  const edgeChanges = new Map(entry.edgeChanges.map((change) => [change.index, change]));
  const nodeCount = useBefore ? entry.beforeNodeCount : entry.afterNodeCount;
  const edgeCount = useBefore ? entry.beforeEdgeCount : entry.afterEdgeCount;
  const nodes = Array.from({ length: nodeCount }, (_, index) => {
    const change = nodeChanges.get(index);
    return (useBefore ? change?.before : change?.after) ?? current.nodes[index];
  });
  const edges = Array.from({ length: edgeCount }, (_, index) => {
    const change = edgeChanges.get(index);
    return (useBefore ? change?.before : change?.after) ?? current.edges[index];
  });
  return {
    nodes,
    edges,
    chatConfig: useBefore
      ? (entry.beforeChatConfig ?? current.chatConfig)
      : (entry.afterChatConfig ?? current.chatConfig)
  };
};

/** 从 strict canonical fixture 创建 Phase 0 Workflow Runtime Port。 */
export const createWorkflowEditor = (
  strictCanonicalData: CanonicalWorkflowData
): WorkflowRuntimePort => {
  const initial = buildDocument(strictCanonicalData);
  let document = initial.document;
  let nodeIndex: Map<string, IndexedNode> = buildNodeIndex(document.nodes);
  let nextEdgeId = initial.nextEdgeId;
  let disposed = false;
  let workflowVersion = 0;
  let semanticVersion = 0;
  let transactionId = 0;
  let debugVersion = 0;
  let debugSequence = 0;
  let debugSession: DebugSessionSnapshot | undefined;
  let issuesByNode = new Map<string, WorkflowCheckIssue[]>();
  let reachableNodeIds = new Set<string>();
  let graphIndex = {
    bySource: new Map(),
    byTarget: new Map(),
    parentByChild: new Map(),
    childrenByParent: new Map(),
    edgeById: new Map()
  } as GraphIndex;
  let workflowStartIds = new Set(
    document.nodes
      .filter(({ data }) => data.flowNodeType === FlowNodeTypeEnum.workflowStart)
      .map(({ data }) => data.nodeId)
  );
  let referenceGraph = buildReferenceGraph(document);
  const listeners = new Set<(change: WorkflowChange) => void>();
  const changeLog: WorkflowChange[] = [];
  const past: HistoryEntry[] = [];
  const future: HistoryEntry[] = [];
  const nodeSnapshotCache = new Map<
    string,
    { record: NodeRecord; issues: WorkflowCheckIssue[]; snapshot: WorkflowNodeSnapshot }
  >();
  const fieldSnapshotCache = new Map<
    string,
    {
      nodeId: string;
      fieldKey: string;
      kind: 'input' | 'output';
      field: FlowNodeInputItemType | FlowNodeOutputItemType;
      statusKey: string;
      snapshot: WorkflowFieldSnapshot;
    }
  >();
  const fieldStatusCache = new Map<
    string,
    { field: FlowNodeInputItemType; statuses: WorkflowReferenceStatus[] }
  >();
  let workflowSnapshotCache: { version: number; snapshot: WorkflowSnapshot } | undefined;
  const nodeViewSnapshotCache = new Map<
    string,
    { view: NodeViewState; snapshot: WorkflowNodeViewSnapshot }
  >();
  let debugSnapshotCache: { version: number; snapshot: DebugSessionSnapshot } | undefined;

  const ensureActive = () => {
    if (disposed) throw new Error('Workflow editor has been disposed');
  };

  const invalidateFieldCaches = (fields: Iterable<WorkflowFieldIdentity>) => {
    for (const field of fields) {
      const key = getFieldIdentityKey(field);
      fieldSnapshotCache.delete(key);
      fieldStatusCache.delete(key);
    }
  };

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

  const rebuildNodeIndex = () => {
    nodeIndex = buildNodeIndex(document.nodes);
  };

  const getNodeByIdInternal = (nodeId: string) => nodeIndex.get(nodeId)?.record;

  const getWorkingNode = (nodeId: string, meta?: MutationMeta) => {
    const change = meta?.nodeChanges.get(nodeId);
    if (change) return change.after;
    return nodeIndex.get(nodeId)?.record;
  };

  const getWorkingNodeIndex = (working: RuntimeDocument, nodeId: string, meta?: MutationMeta) => {
    const change = meta?.nodeChanges.get(nodeId);
    if (change)
      return change.after ? (change.afterIndex ?? working.nodes.indexOf(change.after)) : -1;
    return nodeIndex.get(nodeId)?.index ?? -1;
  };

  const getFlowNodeById = (_working: RuntimeDocument, nodeId: string, meta?: MutationMeta) => {
    const indexedNode = getWorkingNode(nodeId, meta);
    if (indexedNode) return { ...indexedNode.data, id: indexedNode.data.nodeId };
    const data = _working.nodes.find(({ data }) => data.nodeId === nodeId)?.data;
    return data ? { ...data, id: data.nodeId } : undefined;
  };

  const mergeNodeView = ({
    current,
    position,
    isFolded
  }: {
    current: NodeViewState;
    position?: { x: number; y: number };
    isFolded?: boolean;
  }): NodeViewState => ({
    ...current,
    ...(position ? { position: cloneValue(position) } : {}),
    ...(isFolded !== undefined ? { isFolded } : {})
  });

  /** 校验 geometry command 的数值边界；纯 geometry 与混合事务共用此规则。 */
  const validateGeometryCommand = (
    command: Extract<WorkflowCommand, { type: 'commitGeometry' }>
  ): WorkflowCommandError | undefined => {
    if (
      command.position !== undefined &&
      (!isObject(command.position) ||
        typeof command.position.x !== 'number' ||
        !Number.isFinite(command.position.x) ||
        typeof command.position.y !== 'number' ||
        !Number.isFinite(command.position.y))
    ) {
      return getError('invalid_command', 'Geometry position must contain finite x and y');
    }
    if (command.isFolded !== undefined && typeof command.isFolded !== 'boolean') {
      return getError('invalid_command', 'Geometry isFolded must be a boolean');
    }
    return undefined;
  };

  const pruneSnapshotCaches = () => {
    nodeSnapshotCache.forEach((cached, nodeId) => {
      const current = getNodeByIdInternal(nodeId);
      if (!current || cached.record.data !== current.data) nodeSnapshotCache.delete(nodeId);
    });
    nodeViewSnapshotCache.forEach((cached, nodeId) => {
      const current = getNodeByIdInternal(nodeId);
      if (!current || cached.view !== current.view) nodeViewSnapshotCache.delete(nodeId);
    });
  };

  /** 判断边的 source handle 是否仍由分支节点当前配置提供。 */
  const isSourceEdgeValid = (edge: EdgeRecord) => {
    const sourceData = getNodeByIdInternal(edge.data.source)?.data;
    return isWorkflowEdgeSourceHandleValid(
      sourceData ? { ...sourceData, id: sourceData.nodeId } : undefined,
      edge.data.sourceHandle
    );
  };

  const getDescendantNodeIds = (_working: RuntimeDocument, rootIds: ReadonlySet<string>) => {
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
  }) => {
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

  /** 从目标节点反向遍历所有上游节点，visited 保证循环图有限终止。 */
  const getIncomingSources = (nodeId: string) => {
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
        const container = getNodeByIdInternal(targetId);
        container?.data.inputs.forEach((input) => {
          if (!nodeInputIsReference(input)) return;
          getInputReferences(input).forEach(([sourceId]) => {
            if (sourceId === VARIABLE_NODE_ID || !getNodeByIdInternal(sourceId)) return;
            sourceIds.add(sourceId);
            queue.push(sourceId);
          });
        });
      }
      (graphIndex.byTarget.get(targetId) ?? []).forEach((edge) => {
        if (sourceIds.has(edge.data.source) || !isSourceEdgeValid(edge)) return;
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
    const [sourceNodeId] = reference;
    const source = getReferenceSource({
      reference,
      nodes: document.nodes,
      chatConfig: document.chatConfig,
      edges: document.edges
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

    const sourceNode = getNodeByIdInternal(sourceNodeId);
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
  ) => {
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

    getWorkflowGlobalVariables({ chatConfig: document.chatConfig }).forEach((variable) => {
      if (!workflowValueTypeIsCompatible(variable.valueType, input.valueType)) return;
      options.push({
        reference: [VARIABLE_NODE_ID, variable.key],
        sourceType: variable.valueType,
        sourceLabel: 'Variable',
        outputLabel: variable.label,
        icon: 'core/workflow/template/variable'
      });
    });

    return options;
  };

  /** 检查已提交普通字段的基础值类型；引用字段由 Reference View 负责类型诊断。 */
  const hasExpectedValueType = (value: unknown, valueType: WorkflowIOValueTypeEnum | undefined) => {
    if (!valueType || valueType === WorkflowIOValueTypeEnum.any) return true;
    if (
      valueType === WorkflowIOValueTypeEnum.chatHistory ||
      valueType === WorkflowIOValueTypeEnum.datasetQuote ||
      valueType === WorkflowIOValueTypeEnum.dynamic ||
      valueType === WorkflowIOValueTypeEnum.selectApp ||
      valueType === WorkflowIOValueTypeEnum.selectDataset
    ) {
      return true;
    }
    if (valueType === WorkflowIOValueTypeEnum.string) return typeof value === 'string';
    if (valueType === WorkflowIOValueTypeEnum.number)
      return typeof value === 'number' && Number.isFinite(value);
    if (valueType === WorkflowIOValueTypeEnum.boolean) return typeof value === 'boolean';
    if (valueType === WorkflowIOValueTypeEnum.object)
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    if (valueType.startsWith('array')) return Array.isArray(value);
    return true;
  };

  /** 将非正常引用状态转换为稳定的 Issue View 记录。 */
  const issueForStatus = ({
    node,
    input,
    status
  }: {
    node: NodeRecord;
    input: FlowNodeInputItemType;
    status: WorkflowReferenceStatus;
  }): WorkflowCheckIssue | undefined => {
    if (status.code === 'valid' || status.code === 'empty') return undefined;
    const message =
      status.code === 'invalid_reference_type'
        ? `Input ${input.label} has an incompatible reference type`
        : status.code === 'unreachable_reference'
          ? `Input ${input.label} references an unreachable node`
          : `Input ${input.label} has an invalid reference`;
    return {
      nodeId: node.data.nodeId,
      nodeName: node.data.name,
      nodeType: node.data.flowNodeType,
      level: 'error',
      code: status.code,
      message,
      inputKey: input.key
    };
  };

  const calculateReachableNodeIds = () => {
    const nextReachableNodeIds = new Set<string>();
    const visitReachable = (nodeId: string) => {
      if (nextReachableNodeIds.has(nodeId)) return;
      nextReachableNodeIds.add(nodeId);
      (graphIndex.bySource.get(nodeId) ?? [])
        .filter(isSourceEdgeValid)
        .forEach((edge) => visitReachable(edge.data.target));
    };
    document.nodes.forEach((node) => {
      if (
        node.data.flowNodeType === FlowNodeTypeEnum.workflowStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.pluginInput ||
        node.data.flowNodeType === FlowNodeTypeEnum.nestedStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.loopRunStart
      ) {
        visitReachable(node.data.nodeId);
      }
    });
    return nextReachableNodeIds;
  };

  /** 结构变更只刷新受影响的可达性闭包；未触碰节点继续复用旧结果。 */
  const updateReachableNodeIds = (affectedNodeIds: ReadonlySet<string>) => {
    if (affectedNodeIds.size === 0) return;
    const nextReachableNodeIds = new Set(reachableNodeIds);
    affectedNodeIds.forEach((nodeId) => nextReachableNodeIds.delete(nodeId));
    const queue: string[] = [];
    const queued = new Set<string>();
    const enqueue = (nodeId: string) => {
      if (!affectedNodeIds.has(nodeId) || queued.has(nodeId)) return;
      queued.add(nodeId);
      queue.push(nodeId);
    };

    document.nodes.forEach((node) => {
      const nodeId = node.data.nodeId;
      const isStart =
        node.data.flowNodeType === FlowNodeTypeEnum.workflowStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.pluginInput ||
        node.data.flowNodeType === FlowNodeTypeEnum.nestedStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.loopRunStart;
      if (isStart) enqueue(nodeId);
      if (!affectedNodeIds.has(nodeId)) return;
      const hasReachableOutsideSource = (graphIndex.byTarget.get(nodeId) ?? []).some(
        (edge) =>
          !affectedNodeIds.has(edge.data.source) &&
          nextReachableNodeIds.has(edge.data.source) &&
          isSourceEdgeValid(edge)
      );
      if (hasReachableOutsideSource) enqueue(nodeId);
    });

    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const nodeId = queue[queueIndex++];
      nextReachableNodeIds.add(nodeId);
      (graphIndex.bySource.get(nodeId) ?? [])
        .filter(isSourceEdgeValid)
        .forEach((edge) => enqueue(edge.data.target));
    }
    reachableNodeIds = nextReachableNodeIds;
  };

  /** 根据当前 Document 更新 Issue View；局部事务只重算受影响节点。 */
  const rebuildIssues = (onlyNodeIds?: ReadonlySet<string>) => {
    const nextIssues = onlyNodeIds
      ? new Map(issuesByNode)
      : new Map<string, WorkflowCheckIssue[]>();
    if (!onlyNodeIds) reachableNodeIds = calculateReachableNodeIds();

    document.nodes
      .filter((node) => !onlyNodeIds || onlyNodeIds.has(node.data.nodeId))
      .forEach((node) => {
        const issues: WorkflowCheckIssue[] = [];
        const addIssue = (code: string, message: string, inputKey?: string) => {
          if (issues.some((issue) => issue.code === code && issue.inputKey === inputKey)) return;
          issues.push({
            nodeId: node.data.nodeId,
            nodeName: node.data.name,
            nodeType: node.data.flowNodeType,
            level: 'error',
            code,
            message,
            ...(inputKey ? { inputKey } : {})
          });
        };
        const inputs = node.data.inputs;
        const inputMap = new Map(inputs.map((input) => [input.key, input]));
        const getInputValue = (key: string) => {
          const input = inputMap.get(key);
          return input?.value ?? input?.defaultValue;
        };
        const isToolNode = (graphIndex.byTarget.get(node.data.nodeId) ?? []).some(
          (edge) =>
            edge.data.targetHandle === NodeOutputKeyEnum.selectedTools && isSourceEdgeValid(edge)
        );

        node.data.inputs.forEach((input) => {
          const value = input.value ?? input.defaultValue;
          if (input.required && isEmptyValue(value)) {
            addIssue('required', `Input ${input.label} is required`, input.key);
          } else if (
            !isEmptyValue(value) &&
            !nodeInputIsReference(input) &&
            !hasExpectedValueType(value, input.valueType)
          ) {
            addIssue('invalid_type', `Input ${input.label} has an invalid value type`, input.key);
          }
          getFieldStatuses(node.data.nodeId, input).forEach((status) => {
            const issue = issueForStatus({ node, input, status });
            if (issue) addIssue(issue.code, issue.message, issue.inputKey);
          });
        });

        if (node.data.flowNodeType === FlowNodeTypeEnum.ifElseNode) {
          const ifElseList = getInputValue(NodeInputKeyEnum.ifElseList);
          const hasIncompleteCondition =
            !Array.isArray(ifElseList) ||
            ifElseList.some(
              (branch) =>
                !isObject(branch) ||
                !Array.isArray(branch.list) ||
                branch.list.some((condition) => {
                  if (!isObject(condition)) return true;
                  const hasEmptyVariable = isEmptyReferenceValue(condition.variable);
                  const hasEmptyValue =
                    condition.value === undefined ||
                    (condition.valueType === 'reference' && isEmptyReferenceValue(condition.value));
                  return (
                    hasEmptyVariable ||
                    condition.condition === undefined ||
                    (hasEmptyValue &&
                      condition.condition !== 'isEmpty' &&
                      condition.condition !== 'isNotEmpty')
                  );
                })
            );
          if (hasIncompleteCondition) {
            addIssue(
              'if_else_incomplete',
              'If/Else contains an incomplete condition',
              NodeInputKeyEnum.ifElseList
            );
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.userSelect) {
          const options = getInputValue(NodeInputKeyEnum.userSelectOptions);
          if (!Array.isArray(options) || options.length === 0) {
            addIssue(
              'user_select_empty',
              'User selection needs at least one option',
              NodeInputKeyEnum.userSelectOptions
            );
          } else if (options.some((option) => !isObject(option) || !option.value)) {
            addIssue(
              'user_select_value_empty',
              'User selection options cannot be empty',
              NodeInputKeyEnum.userSelectOptions
            );
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.formInput) {
          const forms = getInputValue(NodeInputKeyEnum.userInputForms);
          if (!Array.isArray(forms) || forms.length === 0) {
            addIssue(
              'form_input_empty',
              'Form input needs at least one field',
              NodeInputKeyEnum.userInputForms
            );
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.datasetConcatNode) {
          if (!inputs.some((input) => input.canEdit)) {
            addIssue(
              'required_input_empty',
              'Dataset concat needs at least one dataset quote',
              NodeInputKeyEnum.datasetQuoteList
            );
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.classifyQuestion) {
          const agents = getInputValue(NodeInputKeyEnum.agents);
          if (!Array.isArray(agents) || agents.length === 0) {
            addIssue(
              'classify_question_empty',
              'Classification needs at least one category',
              NodeInputKeyEnum.agents
            );
          } else if (agents.some((agent) => !isObject(agent) || !agent.value)) {
            addIssue(
              'classify_question_value_empty',
              'Classification values cannot be empty',
              NodeInputKeyEnum.agents
            );
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.code) {
          const hasIncompleteDynamicInput = inputs.some((input) => {
            if (
              [
                NodeInputKeyEnum.code,
                NodeInputKeyEnum.codeType,
                NodeInputKeyEnum.addInputParam
              ].includes(input.key as NodeInputKeyEnum) ||
              !input.canEdit
            ) {
              return false;
            }
            if (
              isToolNode &&
              isAgentGeneratedToolInput(
                initToolInputTypeByDefaultMode(input, {
                  allowUserChatInputAgentGenerated: true
                })
              ) &&
              canInputBeAgentGenerated(input)
            ) {
              return false;
            }
            return !input.key || !input.label || isEmptyReferenceValue(input.value);
          });
          if (hasIncompleteDynamicInput) {
            addIssue('code_input_incomplete', 'Code input variables are incomplete');
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.httpRequest468) {
          if (isEmptyValue(getInputValue(NodeInputKeyEnum.httpReqUrl))) {
            addIssue('http_url_empty', 'HTTP request needs a URL', NodeInputKeyEnum.httpReqUrl);
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.contentExtract) {
          const extractKeys = getInputValue(NodeInputKeyEnum.extractKeys);
          if (!Array.isArray(extractKeys) || extractKeys.length === 0) {
            addIssue(
              'context_extract_empty',
              'Content extraction needs at least one target field',
              NodeInputKeyEnum.extractKeys
            );
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.loopRun) {
          if (getInputValue(NodeInputKeyEnum.loopRunMode) === 'conditional') {
            const childIds = getInputValue(NodeInputKeyEnum.childrenNodeIdList);
            const childIdSet = new Set(Array.isArray(childIds) ? childIds : []);
            const hasBreak = document.nodes.some(
              (child) =>
                childIdSet.has(child.data.nodeId) &&
                child.data.flowNodeType === FlowNodeTypeEnum.loopRunBreak
            );
            if (!hasBreak) {
              addIssue('loop_run_missing_break', 'Conditional loop needs a Loop Break node');
            }
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.toolCall) {
          const hasToolConnection = (graphIndex.bySource.get(node.data.nodeId) ?? []).some(
            (edge) =>
              edge.data.sourceHandle === NodeOutputKeyEnum.selectedTools && isSourceEdgeValid(edge)
          );
          if (!hasToolConnection && getInputValue(NodeInputKeyEnum.useAgentSandbox) !== true) {
            addIssue(
              'tool_call_empty',
              'Tool call needs a tool or the agent sandbox',
              NodeInputKeyEnum.useAgentSandbox
            );
          }
        }

        if (node.data.flowNodeType === FlowNodeTypeEnum.variableUpdate) {
          const updateList = getInputValue(NodeInputKeyEnum.updateList);
          const isUpdateValueEmpty = (item: Record<string, unknown>) => {
            if (item.renderType === 'reference') return isEmptyReferenceValue(item.value);
            if (item.arrayMode === 'clear' || item.booleanMode) return false;
            const value = item.value;
            return (
              !Array.isArray(value) ||
              value[1] === undefined ||
              value[1] === null ||
              value[1] === ''
            );
          };
          if (
            !Array.isArray(updateList) ||
            updateList.length === 0 ||
            updateList.some(
              (item) =>
                !isObject(item) || isEmptyReferenceValue(item.variable) || isUpdateValueEmpty(item)
            )
          ) {
            addIssue(
              'required_input_empty',
              'Variable update contains an incomplete item',
              NodeInputKeyEnum.updateList
            );
          }
        }

        if (getPlacementError({ working: document, node, parentId: node.data.parentNodeId })) {
          addIssue('invalid_placement', 'Node placement is not allowed');
        }

        const incoming = (graphIndex.byTarget.get(node.data.nodeId) ?? []).some((edge) =>
          isSourceEdgeValid(edge)
        );
        if (!incoming && !noUpstreamExemptTypes.has(node.data.flowNodeType)) {
          issues.push({
            nodeId: node.data.nodeId,
            nodeName: node.data.name,
            nodeType: node.data.flowNodeType,
            level: 'warning',
            code: 'no_upstream',
            message: 'Node is not connected to an upstream node'
          });
        } else if (
          incoming &&
          reachableNodeIds.size > 0 &&
          !reachableNodeIds.has(node.data.nodeId) &&
          !noUpstreamExemptTypes.has(node.data.flowNodeType)
        ) {
          addIssue('unreachable_from_start', 'Node cannot be reached from a workflow start node');
        }
        const previous = issuesByNode.get(node.data.nodeId);
        nextIssues.set(
          node.data.nodeId,
          previous && valuesEqual(previous, issues) ? previous : issues
        );
      });
    onlyNodeIds?.forEach((nodeId) => {
      if (!getNodeByIdInternal(nodeId)) nextIssues.delete(nodeId);
    });
    issuesByNode = nextIssues;
    if (!onlyNodeIds)
      fieldSnapshotCache.forEach((cached, cacheKey) => {
        const node = getNodeByIdInternal(cached.nodeId);
        const field =
          cached.kind === 'input'
            ? node?.data.inputs.find((item) => item.key === cached.fieldKey)
            : node?.data.outputs.find((item) => item.id === cached.fieldKey);
        if (!field || field !== cached.field) fieldSnapshotCache.delete(cacheKey);
      });
    if (!onlyNodeIds)
      fieldStatusCache.forEach((cached, cacheKey) => {
        const identity = parseFieldIdentityKey(cacheKey);
        const field =
          identity?.kind === 'input'
            ? getNodeByIdInternal(identity.nodeId)?.data.inputs.find(
                (item) => item.key === identity.key
              )
            : undefined;
        if (!field || field !== cached.field) fieldStatusCache.delete(cacheKey);
      });
  };

  /** 返回 Node Data scoped snapshot，并仅缓存当前 Node Data 与 Issue 数组。 */
  const getNodeSnapshot = (nodeId: string): WorkflowNodeSnapshot | undefined => {
    ensureActive();
    const node = getNodeByIdInternal(nodeId);
    if (!node) return undefined;
    const issues = issuesByNode.get(nodeId) ?? [];
    const cached = nodeSnapshotCache.get(nodeId);
    if (cached?.record.data === node.data && cached.issues === issues) return cached.snapshot;
    const snapshot = freezeValue({
      ...cloneValue(node.data),
      issues: cloneValue(issues)
    }) as WorkflowNodeSnapshot;
    nodeSnapshotCache.set(nodeId, { record: node, issues, snapshot });
    return snapshot;
  };

  /** 返回 Node View State scoped snapshot；同一视图记录保持对象身份稳定。 */
  const getNodeViewSnapshot = (nodeId: string): WorkflowNodeViewSnapshot | undefined => {
    ensureActive();
    const node = getNodeByIdInternal(nodeId);
    if (!node) return undefined;
    const cached = nodeViewSnapshotCache.get(nodeId);
    if (cached?.view === node.view) return cached.snapshot;
    const snapshot = freezeValue(cloneValue(node.view)) as WorkflowNodeViewSnapshot;
    nodeViewSnapshotCache.set(nodeId, { view: node.view, snapshot });
    return snapshot;
  };

  /** 返回 workflow scoped snapshot；版本不变时保持对象身份稳定。 */
  const getWorkflowSnapshot = (): WorkflowSnapshot => {
    ensureActive();
    if (workflowSnapshotCache?.version === semanticVersion) return workflowSnapshotCache.snapshot;
    const snapshot = freezeValue({
      nodes: document.nodes.map((node) => getNodeSnapshot(node.data.nodeId)!),
      edges: document.edges.map((edge) => cloneValue(edge.data)) as WorkflowEdgeSnapshot[],
      chatConfig: cloneValue(document.chatConfig),
      issues: Array.from(issuesByNode.values()).flatMap((issues) => cloneValue(issues))
    }) as WorkflowSnapshot;
    workflowSnapshotCache = { version: semanticVersion, snapshot };
    return snapshot;
  };

  /** 返回当前独立 Debug State；其 workflow snapshot 不随编辑事务变化。 */
  const getDebugSnapshot = (): DebugSessionSnapshot | undefined => {
    ensureActive();
    if (!debugSession) return undefined;
    if (debugSnapshotCache?.version === debugVersion) return debugSnapshotCache.snapshot;
    const snapshot = freezeValue(cloneValue(debugSession));
    debugSnapshotCache = { version: debugVersion, snapshot };
    return snapshot;
  };

  /** 返回单字段 snapshot，并按字段引用与引用状态缓存身份。 */
  const getFieldSnapshot = ({
    nodeId,
    fieldKey,
    kind
  }: WorkflowFieldQuery): WorkflowFieldSnapshot | undefined => {
    ensureActive();
    const node = getNodeByIdInternal(nodeId);
    if (!node) return undefined;
    const input =
      kind !== 'output' ? node.data.inputs.find((item) => item.key === fieldKey) : undefined;
    const output =
      kind !== 'input' ? node.data.outputs.find((item) => item.id === fieldKey) : undefined;
    const field = input ?? output;
    if (!field) return undefined;
    const fieldKind = input ? 'input' : 'output';
    const cacheKey = getFieldIdentityKey({ nodeId, kind: fieldKind, key: fieldKey });
    const cached = fieldSnapshotCache.get(cacheKey);
    if (cached?.field === field) return cached.snapshot;

    const statuses = input ? getFieldStatuses(nodeId, input) : [];
    const referenceOptions = input ? getReferenceOptions(nodeId, input) : [];
    const statusKey = JSON.stringify({ statuses, referenceOptions });
    const snapshot = freezeValue({
      nodeId,
      key: fieldKey,
      kind: fieldKind,
      ...(input ? { input: cloneValue(input) } : { output: cloneValue(output) }),
      references: cloneValue(statuses),
      referenceOptions: cloneValue(referenceOptions)
    }) as WorkflowFieldSnapshot;
    fieldSnapshotCache.set(cacheKey, {
      nodeId,
      fieldKey,
      kind: fieldKind,
      field,
      statusKey,
      snapshot
    });
    return snapshot;
  };

  /** 读取 history 的可观察计数，不暴露可逆操作记录。 */
  const getHistorySnapshot = (): HistorySnapshot =>
    freezeValue({
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      undoCount: past.length,
      redoCount: future.length
    }) as HistorySnapshot;

  /** 将内部 mutation meta 转为冻结的精确变更事件。 */
  const makeChange = (meta: MutationMeta, origin: 'command' | 'undo' | 'redo'): WorkflowChange => {
    const base = {
      origin,
      version: workflowVersion,
      transactionId: ++transactionId
    };
    const changedRecords: WorkflowChangedRecords = {
      nodeIds: [...meta.changedNodeIds],
      nodeViewIds: [...meta.changedNodeViewIds],
      fieldIds: [...meta.changedFieldIds.values()],
      edgeIds: [...meta.changedEdgeIds],
      chatConfig: meta.chatConfigChanged
    };
    const affectedRecords: WorkflowAffectedRecords = {
      nodeIds: [...meta.affectedNodeIds],
      fieldIds: [...meta.affectedFieldIds.values()],
      structure: meta.structureChanged
    };
    return freezeValue({
      ...base,
      kind: meta.kind,
      changedRecords,
      affectedRecords
    }) as WorkflowChange;
  };

  const addAffectedConsumerFields = (
    meta: MutationMeta,
    graph: ReferenceGraph,
    sourceNodeIds: ReadonlySet<string>,
    fieldIds = meta.affectedFieldIds
  ) => {
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

  /** 结构边变化会影响目标及其下游的可达性，按两版边集合取保守闭包。 */
  const addAffectedStructure = ({
    meta,
    before: _before,
    after: _after
  }: {
    meta: MutationMeta;
    before: RuntimeDocument;
    after: RuntimeDocument;
  }) => {
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

  /** Issue View 是同步派生结果；只把实际变更的节点加入 affected records。 */
  const addChangedIssueRecords = (
    meta: MutationMeta,
    previous: Map<string, WorkflowCheckIssue[]>,
    candidateNodeIds: ReadonlySet<string>
  ) => {
    const nodeIds = candidateNodeIds;
    nodeIds.forEach((nodeId) => {
      if (valuesEqual(previous.get(nodeId) ?? [], issuesByNode.get(nodeId) ?? [])) return;
      meta.affectedNodeIds.add(nodeId);
      [...(previous.get(nodeId) ?? []), ...(issuesByNode.get(nodeId) ?? [])].forEach((issue) => {
        if (!issue.inputKey) return;
        addFieldIdentity(meta.affectedFieldIds, {
          nodeId,
          key: issue.inputKey,
          kind: 'input'
        });
      });
    });
  };

  /** 先记录再通知；单个 listener 异常不能破坏其他订阅者的一致观察。 */
  const publish = (change: WorkflowChange) => {
    changeLog.push(change);
    if (changeLog.length > MAX_CHANGE_LOG) changeLog.splice(0, changeLog.length - MAX_CHANGE_LOG);
    listeners.forEach((listener) => {
      try {
        listener(change);
      } catch {
        // 一个订阅者失败不能阻止其他订阅者观察完整事务。
      }
    });
  };

  /** 将一次新增/连线意图产生的流程开始引用补丁并入同一 working transaction。 */
  const applyWorkflowStartAutoFill = ({
    working,
    meta,
    referenceGraph
  }: {
    working: RuntimeDocument;
    meta: MutationMeta;
    referenceGraph: ReferenceGraph;
  }) => {
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
          const targetIndex = getWorkingNodeIndex(working, nodeId, meta);
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

  /** 在隔离 working document 上应用一个命令；异常只会丢弃本次 transaction。 */
  const applyCommand = ({
    working,
    command,
    meta,
    referenceGraph
  }: {
    working: RuntimeDocument;
    command: WorkflowCommand;
    meta: MutationMeta;
    referenceGraph: ReferenceGraph;
  }): void => {
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
        const index = getWorkingNodeIndex(working, command.nodeId, meta);
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
        const index = getWorkingNodeIndex(working, command.nodeId, meta);
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
        const index = getWorkingNodeIndex(working, command.nodeId, meta);
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
        const descendantIds = getDescendantNodeIds(working, rootIds);
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
        const edgeId = `edge-${nextEdgeId++}`;
        const edgeRecord = { id: edgeId, data: cloneValue(edge) };
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
        const nodeIndex = getWorkingNodeIndex(working, command.nodeId, meta);
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
          getDescendantNodeIds(working, new Set([command.nodeId])).has(command.containerId)
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
      case 'updateChatConfig':
        {
          const nextChatConfig = AppChatConfigTypeSchema.parse(cloneValue(command.chatConfig));
          meta.chatConfigChanged = !valuesEqual(working.chatConfig, nextChatConfig);
          working.chatConfig = nextChatConfig;
        }
        return;
      case 'commitGeometry': {
        const validationError = validateGeometryCommand(command);
        if (validationError) throw validationError;
        const index = getWorkingNodeIndex(working, command.nodeId, meta);
        if (index < 0) throw getError('not_found', `Node not found: ${command.nodeId}`);
        const current = working.nodes[index];
        const position = command.position;
        const nextView = mergeNodeView({
          current: current.view,
          position,
          isFolded: command.isFolded
        });
        const viewChanged = !valuesEqual(current.view, nextView);
        working.nodes = working.nodes.slice();
        working.nodes[index] = { data: current.data, view: nextView };
        if (viewChanged) meta.changedNodeViewIds.add(command.nodeId);
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

  /** 纯 geometry 事务只改 Node View、history 和事件，跳过语义派生状态。 */
  const dispatchGeometry = (
    commands: readonly Extract<WorkflowCommand, { type: 'commitGeometry' }>[]
  ): WorkflowDispatchResult => {
    const nextViews = new Map<string, NodeViewState>();

    for (const command of commands) {
      const indexedNode = nodeIndex.get(command.nodeId);
      if (!indexedNode) {
        return {
          ok: false,
          error: getError('not_found', `Node not found: ${command.nodeId}`)
        };
      }
      const validationError = validateGeometryCommand(command);
      if (validationError) return { ok: false, error: validationError };

      const currentView = nextViews.get(command.nodeId) ?? indexedNode.record.view;
      const nextView = mergeNodeView({
        current: currentView,
        position: command.position,
        isFolded: command.isFolded
      });
      nextViews.set(command.nodeId, nextView);
    }

    const changedViews = Array.from(nextViews.entries()).filter(([nodeId, nextView]) => {
      const current = nodeIndex.get(nodeId)?.record;
      return current !== undefined && !valuesEqual(current.view, nextView);
    });
    if (changedViews.length === 0) return { ok: true };

    const before = document;
    const nextNodes = document.nodes.slice();
    const nodeChanges: Extract<HistoryEntry, { kind: 'delta' }>['nodeChanges'] = [];
    const meta = createMutationMeta('geometry');
    changedViews.forEach(([nodeId, nextView]) => {
      const indexedNode = nodeIndex.get(nodeId)!;
      const nextRecord = { data: indexedNode.record.data, view: nextView };
      nextNodes[indexedNode.index] = nextRecord;
      nodeIndex.set(nodeId, { record: nextRecord, index: indexedNode.index });
      nodeChanges.push({
        index: indexedNode.index,
        before: indexedNode.record,
        after: nextRecord
      });
      meta.changedNodeViewIds.add(nodeId);
    });
    document = { ...document, nodes: nextNodes };
    workflowVersion++;

    const change = makeChange(meta, 'command');
    past.push({
      kind: 'delta',
      beforeNodeCount: before.nodes.length,
      afterNodeCount: document.nodes.length,
      nodeChanges,
      beforeEdgeCount: before.edges.length,
      afterEdgeCount: document.edges.length,
      edgeChanges: [],
      change
    });
    if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
    future.length = 0;
    publish(change);
    return { ok: true, change };
  };

  /** 执行单命令或原子命令数组；失败时 working 副本直接丢弃。 */
  const dispatch = (
    commands: WorkflowCommand | readonly WorkflowCommand[]
  ): WorkflowDispatchResult => {
    if (disposed)
      return { ok: false, error: getError('disposed', 'Workflow editor has been disposed') };
    const list = Array.isArray(commands) ? [...commands] : [commands];
    if (list.length === 0) return { ok: true };
    if (list.some((command) => !isWorkflowCommand(command))) {
      return { ok: false, error: getError('invalid_command', 'Unknown workflow command') };
    }
    if (list.some((command) => command.type === 'replaceDocument') && list.length !== 1) {
      return {
        ok: false,
        error: getError(
          'invalid_command',
          'replaceDocument must be the only command in a transaction'
        )
      };
    }
    if (list.every((command) => command.type === 'commitGeometry')) {
      return dispatchGeometry(
        list as readonly Extract<WorkflowCommand, { type: 'commitGeometry' }>[]
      );
    }
    const before = document;
    const beforeNextEdgeId = nextEdgeId;
    const beforeReferenceGraph = referenceGraph;
    const workingReferenceGraph = cloneReferenceGraph(referenceGraph);
    const working: RuntimeDocument = {
      nodes: document.nodes.slice(),
      edges: document.edges.slice(),
      chatConfig: document.chatConfig
    };
    const meta = createMutationMeta(
      list.every((command) => command.type === 'commitGeometry') ? 'geometry' : 'semantic'
    );
    try {
      list.forEach((command) =>
        applyCommand({ working, command, meta, referenceGraph: workingReferenceGraph })
      );
      if (list.some((command) => command.type === 'connectEdge')) {
        applyWorkflowStartAutoFill({
          working,
          meta,
          referenceGraph: workingReferenceGraph
        });
      }
    } catch (error) {
      nextEdgeId = beforeNextEdgeId;
      const commandError = isWorkflowCommandError(error)
        ? error
        : getError('invalid_command', error instanceof Error ? error.message : String(error));
      return { ok: false, error: commandError };
    }
    const hasChanges =
      meta.kind === 'replace' ||
      meta.changedNodeIds.size > 0 ||
      meta.changedNodeViewIds.size > 0 ||
      meta.changedEdgeIds.size > 0 ||
      meta.chatConfigChanged;
    if (!hasChanges) {
      nextEdgeId = beforeNextEdgeId;
      return { ok: true };
    }

    meta.structureChanged =
      meta.changedEdgeIds.size > 0 ||
      [...meta.nodeChanges.values()].some(
        ({ before: previous, after: next }) =>
          !previous ||
          !next ||
          previous.data.parentNodeId !== next.data.parentNodeId ||
          previous.data.flowNodeType !== next.data.flowNodeType ||
          !valuesEqual(previous.data.outputs, next.data.outputs)
      );
    document = working;
    workflowVersion++;
    if (meta.kind !== 'geometry') semanticVersion++;
    const previousIssues = issuesByNode;
    if (meta.kind === 'replace') {
      rebuildNodeIndex();
      rebuildGraphIndex();
      workflowStartIds = new Set(
        document.nodes
          .filter(({ data }) => data.flowNodeType === FlowNodeTypeEnum.workflowStart)
          .map(({ data }) => data.nodeId)
      );
      referenceGraph = buildReferenceGraph(document);
      rebuildIssues();
      fieldSnapshotCache.clear();
    } else {
      updateNodeIndexIncrementally(meta);
      updateGraphIndexIncrementally(meta);
      updateWorkflowStartIndex(meta);
      referenceGraph = compactReferenceGraph(workingReferenceGraph);
      const issueNodeIds = new Set(meta.affectedNodeIds);
      meta.changedNodeIds.forEach((nodeId) => issueNodeIds.add(nodeId));
      const referenceFieldIds = new Map<string, WorkflowFieldIdentity>();
      addAffectedConsumerFields(meta, beforeReferenceGraph, meta.changedNodeIds);
      addAffectedConsumerFields(meta, referenceGraph, meta.changedNodeIds);
      const changedReferenceSourceNodeIds = new Set<string>();
      meta.nodeChanges.forEach(({ before: previous, after: next }, nodeId) => {
        if (!previous || !next) {
          changedReferenceSourceNodeIds.add(nodeId);
          return;
        }
        const sourceMetadataChanged =
          previous.data.name !== next.data.name ||
          previous.data.avatar !== next.data.avatar ||
          previous.data.flowNodeType !== next.data.flowNodeType ||
          previous.data.catchError !== next.data.catchError ||
          !valuesEqual(previous.data.outputs, next.data.outputs) ||
          (previous.data.flowNodeType === FlowNodeTypeEnum.httpRequest468 &&
            !valuesEqual(previous.data.inputs, next.data.inputs));
        if (sourceMetadataChanged) changedReferenceSourceNodeIds.add(nodeId);
      });
      [...meta.addedEdges.values(), ...meta.removedEdges.values()].forEach((edge) => {
        if (edge.data.targetHandle === NodeOutputKeyEnum.selectedTools) {
          changedReferenceSourceNodeIds.add(edge.data.target);
        }
      });
      addAffectedConsumerFields(
        meta,
        beforeReferenceGraph,
        changedReferenceSourceNodeIds,
        referenceFieldIds
      );
      addAffectedConsumerFields(
        meta,
        referenceGraph,
        changedReferenceSourceNodeIds,
        referenceFieldIds
      );
      if (meta.chatConfigChanged) {
        const variableSources = new Set([VARIABLE_NODE_ID]);
        addAffectedConsumerFields(meta, beforeReferenceGraph, variableSources);
        addAffectedConsumerFields(meta, referenceGraph, variableSources);
        addAffectedConsumerFields(meta, beforeReferenceGraph, variableSources, referenceFieldIds);
        addAffectedConsumerFields(meta, referenceGraph, variableSources, referenceFieldIds);
      }
      addAffectedStructure({ meta, before, after: document });
      meta.affectedNodeIds.forEach((nodeId) => issueNodeIds.add(nodeId));
      if (meta.structureChanged) updateReachableNodeIds(meta.affectedNodeIds);
      invalidateFieldCaches([
        ...meta.changedFieldIds.values(),
        ...referenceFieldIds.values(),
        ...(meta.structureChanged
          ? [...meta.affectedFieldIds.values()].filter((field) => {
              if (field.kind !== 'input') return false;
              const input = nodeIndex
                .get(field.nodeId)
                ?.record.data.inputs.find((item) => item.key === field.key);
              return input ? getInputReferences(input).length > 0 : false;
            })
          : [])
      ]);
      rebuildIssues(issueNodeIds);
      addChangedIssueRecords(meta, previousIssues, issueNodeIds);
    }
    const change = makeChange(meta, 'command');
    past.push(createHistoryEntry({ before, after: document, change }));
    if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
    future.length = 0;
    pruneSnapshotCaches();

    // endregion

    publish(change);
    return {
      ok: true,
      change,
      ...(meta.reportsDeletedEdgeCount ? { deletedEdgeCount: meta.deletedEdgeCount } : {})
    };
  };

  /** 以 undo/redo 来源重放 history，不新增 history entry。 */
  const replayHistory = (direction: 'undo' | 'redo'): WorkflowDispatchResult => {
    if (disposed)
      return { ok: false, error: getError('disposed', 'Workflow editor has been disposed') };
    const source = direction === 'undo' ? past : future;
    const target = direction === 'undo' ? future : past;
    const entry = source.pop();
    if (!entry) return { ok: false, error: getError('invalid_command', `Nothing to ${direction}`) };
    const originalChange = entry.change;
    const previousIssues = issuesByNode;
    document = materializeHistoryDocument(document, entry, direction);
    target.push(entry);
    workflowVersion++;
    if (originalChange.kind === 'geometry') {
      originalChange.changedRecords.nodeViewIds.forEach((nodeId) => {
        const indexedNode = nodeIndex.get(nodeId);
        if (indexedNode) {
          nodeIndex.set(nodeId, {
            record: document.nodes[indexedNode.index],
            index: indexedNode.index
          });
        }
      });
    } else {
      rebuildNodeIndex();
      semanticVersion++;
      rebuildGraphIndex();
      workflowStartIds = new Set(
        document.nodes
          .filter(({ data }) => data.flowNodeType === FlowNodeTypeEnum.workflowStart)
          .map(({ data }) => data.nodeId)
      );
      fieldStatusCache.clear();
      rebuildIssues();
      referenceGraph = buildReferenceGraph(document);
      fieldSnapshotCache.clear();
    }
    const meta = createMutationMeta(originalChange.kind);
    originalChange.changedRecords.nodeIds.forEach((nodeId) => meta.changedNodeIds.add(nodeId));
    originalChange.changedRecords.nodeViewIds.forEach((nodeId) =>
      meta.changedNodeViewIds.add(nodeId)
    );
    originalChange.changedRecords.fieldIds.forEach((field) =>
      addFieldIdentity(meta.changedFieldIds, field)
    );
    originalChange.changedRecords.edgeIds.forEach((edgeId) => meta.changedEdgeIds.add(edgeId));
    meta.chatConfigChanged = originalChange.changedRecords.chatConfig;
    originalChange.affectedRecords.nodeIds.forEach((nodeId) => meta.affectedNodeIds.add(nodeId));
    originalChange.affectedRecords.fieldIds.forEach((field) =>
      addFieldIdentity(meta.affectedFieldIds, field)
    );
    meta.structureChanged = originalChange.affectedRecords.structure;
    if (originalChange.kind === 'replace') {
      meta.structureChanged = true;
    } else {
      addChangedIssueRecords(
        meta,
        previousIssues,
        new Set([...meta.affectedNodeIds, ...meta.changedNodeIds])
      );
    }
    const change = makeChange(meta, direction);
    pruneSnapshotCaches();
    publish(change);
    return { ok: true, change };
  };

  rebuildNodeIndex();
  rebuildGraphIndex();
  rebuildIssues();

  const port: WorkflowRuntimePort = {
    getWorkflow: getWorkflowSnapshot,
    /** 返回不含 runtime-only state 的 canonical 深拷贝；runtime disposed 后拒绝读取。 */
    getWorkflowData: () => {
      ensureActive();
      return cloneValue(
        documentToCanonical({
          ...document
        })
      );
    },
    getNode: (nodeId) => getNodeSnapshot(nodeId),
    getNodeView: (nodeId) => getNodeViewSnapshot(nodeId),
    getField: getFieldSnapshot,
    getDebug: getDebugSnapshot,
    getHistory: getHistorySnapshot,
    getChangeLog: () => freezeValue([...changeLog]) as readonly WorkflowChange[],
    dispatch,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    undo: () => replayHistory('undo'),
    redo: () => replayHistory('redo'),
    startDebug: (options: DebugStartOptions = {}) => {
      ensureActive();
      const sessionId = `debug-${++debugSequence}`;
      debugSession = {
        sessionId,
        status: 'running',
        workflow: cloneValue(documentToCanonical(document)),
        formValues: cloneValue(options.formValues ?? {}),
        results: {}
      };
      debugVersion++;
      debugSnapshotCache = undefined;
      return getDebugSnapshot()!;
    },
    setDebugResult: (nodeId, result) => {
      if (disposed || !debugSession) return;
      debugSession = {
        ...debugSession,
        results: { ...debugSession.results, [nodeId]: cloneValue(result) }
      };
      debugVersion++;
      debugSnapshotCache = undefined;
    },
    finishDebug: (status = 'success') => {
      if (disposed || !debugSession) return;
      debugSession = { ...debugSession, status };
      debugVersion++;
      debugSnapshotCache = undefined;
    },
    clearDebug: () => {
      if (disposed) return;
      debugSession = undefined;
      debugVersion++;
      debugSnapshotCache = undefined;
    },
    isDisposed: () => disposed,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      changeLog.length = 0;
      past.length = 0;
      future.length = 0;
      nodeSnapshotCache.clear();
      nodeViewSnapshotCache.clear();
      fieldSnapshotCache.clear();
      fieldStatusCache.clear();
      issuesByNode.clear();
      nodeIndex.clear();
      graphIndex.bySource.clear();
      graphIndex.byTarget.clear();
      graphIndex.parentByChild.clear();
      graphIndex.childrenByParent.clear();
      graphIndex.edgeById.clear();
      workflowStartIds.clear();
      workflowSnapshotCache = undefined;
      debugSnapshotCache = undefined;
      debugSession = undefined;
      document = { nodes: [], edges: [], chatConfig: {} };
    }
  };

  return port;
};
