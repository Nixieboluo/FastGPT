import type {
  NodeViewState,
  RuntimeEdgeId,
  WorkflowChange,
  WorkflowCommand,
  WorkflowCommandError,
  WorkflowFieldIdentity,
  WorkflowNodeData,
  WorkflowReferenceStatus
} from '../types';
import type { StoreEdgeItemType } from '../../type/edge';
import type { FlowNodeInputItemType, FlowNodeOutputItemType } from '../../type/io';
import type { AppChatConfigType } from '../../../app/type';

/** Runtime 内部私有契约；不通过 editor/index.ts 对外暴露。 */

export type NodeRecord = {
  data: WorkflowNodeData;
  view: NodeViewState;
  /** 模板运行时元数据；不能进入 StoreWorkflow 或公开 snapshot。 */
  forbidDelete?: true;
};

export type IndexedNode = {
  record: NodeRecord;
  index: number;
};

export type EdgeRecord = {
  id: RuntimeEdgeId;
  data: StoreEdgeItemType;
};

export type RuntimeDocument = {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
  chatConfig: AppChatConfigType;
};

export type GraphIndex = {
  bySource: Map<string, EdgeRecord[]>;
  byTarget: Map<string, EdgeRecord[]>;
  parentByChild: Map<string, string>;
  childrenByParent: Map<string, string[]>;
  edgeById: Map<string, EdgeRecord>;
};

export type ReferenceSource = {
  output?: FlowNodeOutputItemType;
  sourceLabel?: string;
  outputLabel?: string;
  icon?: string;
};

export type ReferenceGraph = {
  /** 每层只保存本次事务触碰的 key；parent 让普通命令无需复制全图。 */
  parent?: ReferenceGraph;
  consumersBySource: Map<string, Set<string> | null>;
  sourcesByConsumer: Map<string, Set<string> | null>;
  sourceKeysByNode: Map<string, Set<string> | null>;
  depth: number;
};

/** 一笔事务内所有 reducer 共享的变更记录；由 Runtime Core 创建并在提交时统一读取。 */
export type MutationMeta = {
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

export type HistoryEntry =
  | {
      kind: 'delta';
      beforeNodeCount: number;
      afterNodeCount: number;
      nodeChanges: Array<{ index: number; before?: NodeRecord; after?: NodeRecord }>;
      beforeEdgeCount: number;
      afterEdgeCount: number;
      edgeChanges: Array<{ index: number; before?: EdgeRecord; after?: EdgeRecord }>;
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

export type FieldStatusCache = {
  field: FlowNodeInputItemType;
  statuses: WorkflowReferenceStatus[];
};

export type CanonicalResult = {
  document: RuntimeDocument;
  nextEdgeId: number;
};

/** 交给后续 module 的 Document 只读窄接口；module 不能写 Document 状态。 */
export type DocumentReadApi = {
  readonly getDocument: () => RuntimeDocument;
  readonly getNodeById: (nodeId: string) => NodeRecord | undefined;
  readonly getNodeIndex: () => ReadonlyMap<string, IndexedNode>;
  readonly getGraphIndex: () => GraphIndex;
  readonly isSourceEdgeValid: (edge: EdgeRecord) => boolean;
  /** 读取 staged 事务中的节点下标；未进入 meta 时回落到已提交索引。 */
  readonly getWorkingNodeIndex: (args: {
    working: RuntimeDocument;
    nodeId: string;
    meta?: MutationMeta;
  }) => number;
};

/** Issue module 需要的 Reference 只读窄接口。 */
export type ReferenceReadApi = {
  readonly getFieldStatuses: (
    nodeId: string,
    field: FlowNodeInputItemType | FlowNodeOutputItemType
  ) => WorkflowReferenceStatus[];
};

/**
 * 事务级 staging 上下文。Runtime Core 创建，按命令归属交给对应 module 的 reducer。
 * reducer 只写 `working` 中自己负责的记录，并把结果登记到 `meta`。
 */
export type TransactionContext = {
  working: RuntimeDocument;
  meta: MutationMeta;
  referenceGraph: ReferenceGraph;
};

/** 不参与 Node View 的命令；commitGeometry 由 NodeView module 单独处理。 */
export type SemanticCommand = Exclude<WorkflowCommand, { type: 'commitGeometry' }>;

export type GeometryCommand = Extract<WorkflowCommand, { type: 'commitGeometry' }>;

/** 一次节点记录替换；index 用于避免在提交时扫描整个 document。 */
export type NodeRecordChange = { index: number; before: NodeRecord; after: NodeRecord };

/** 纯 geometry 事务的 staging 结果；由 Runtime Core 提交并发布。 */
export type GeometryStageResult =
  | { ok: false; error: WorkflowCommandError }
  | { ok: true; nodeChanges?: NodeRecordChange[] };
