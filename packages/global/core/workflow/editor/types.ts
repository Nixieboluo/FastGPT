import type { AppChatConfigType } from '../../app/type';
import type { CanonicalWorkflowData } from '../migration/schema';
import type {
  FlowNodeInputItemType,
  FlowNodeOutputItemType,
  ReferenceItemValueType,
  ReferenceValueType
} from '../type/io';
import type { StoreEdgeItemType } from '../type/edge';
import type { StoreNodeItemType, WorkflowCheckIssue } from '../type/node';
import type { WorkflowIOValueTypeEnum } from '../constants';

/** 递归只读类型，用于阻止调用方通过 scoped snapshot 修改运行时数据。 */
export type DeepReadonly<T> = T extends (...args: any[]) => any
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** 不包含 position/isFolded 的节点语义数据。 */
export type WorkflowNodeData = Omit<StoreNodeItemType, 'position' | 'isFolded'>;

/** 画布持久化节点视图，不携带任何节点配置。 */
export type NodeViewState = {
  position?: { x: number; y: number };
  isFolded?: boolean;
};

/** 单个节点的持久化视图 snapshot。 */
export type WorkflowNodeViewSnapshot = DeepReadonly<NodeViewState>;

/** 单个节点的公开 scoped snapshot。 */
export type WorkflowNodeSnapshot = DeepReadonly<
  WorkflowNodeData & {
    issues: WorkflowCheckIssue[];
  }
>;

/** 单条连接的公开 snapshot；Runtime Edge ID 保持在 runtime 内部。 */
export type WorkflowEdgeSnapshot = DeepReadonly<StoreEdgeItemType>;

/** 一条输入或输出字段的引用诊断。 */
export type WorkflowReferenceStatusCode =
  | 'empty'
  | 'valid'
  | 'invalid_reference'
  | 'unreachable_reference'
  | 'invalid_reference_type';

export type WorkflowReferenceStatus = {
  code: WorkflowReferenceStatusCode;
  sourceType?: WorkflowIOValueTypeEnum;
  reference?: ReferenceValueType;
  sourceLabel?: string;
  outputLabel?: string;
  icon?: string;
};

/** Reference View 中可供当前字段选择的实时来源输出。 */
export type WorkflowReferenceOption = {
  reference: ReferenceItemValueType;
  sourceType?: WorkflowIOValueTypeEnum;
  sourceLabel?: string;
  outputLabel?: string;
  icon?: string;
};

/** 字段 scoped snapshot，输入与输出都使用 Node Field Identity。 */
export type WorkflowFieldSnapshot = DeepReadonly<{
  nodeId: string;
  key: string;
  kind: 'input' | 'output';
  input?: FlowNodeInputItemType;
  output?: FlowNodeOutputItemType;
  references: WorkflowReferenceStatus[];
  referenceOptions: WorkflowReferenceOption[];
}>;

/** 字段读取参数；使用对象便于后续增加 scoped 查询条件。 */
export type WorkflowFieldQuery = {
  nodeId: string;
  fieldKey: string;
  kind?: 'input' | 'output';
};

/** 工作流 scoped snapshot，issues 为当前所有节点问题的扁平只读视图。 */
export type WorkflowSnapshot = DeepReadonly<{
  nodes: WorkflowNodeSnapshot[];
  edges: WorkflowEdgeSnapshot[];
  chatConfig: AppChatConfigType;
  issues: WorkflowCheckIssue[];
}>;

/** 独立 Debug State 会话。workflow 是启动瞬间的 immutable snapshot。 */
export type DebugSessionSnapshot = DeepReadonly<{
  sessionId: string;
  status: 'idle' | 'running' | 'success' | 'failed';
  workflow: CanonicalWorkflowData;
  formValues: Record<string, unknown>;
  results: Record<string, unknown>;
}>;

/** 一次 history entry 的公开状态。 */
export type HistorySnapshot = DeepReadonly<{
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}>;

/** 通知来源，undo/redo 也通过同一 external-store 事件通道发布。 */
export type WorkflowChangeOrigin = 'command' | 'undo' | 'redo';

/** Node Data 内字段的稳定身份；input 用 key，output 用 output id。 */
export type WorkflowFieldIdentity = {
  nodeId: string;
  key: string;
  kind: 'input' | 'output';
};

/** Runtime 内单条边的稳定身份；该身份永不进入 StoreWorkflow。 */
export type RuntimeEdgeId = string;

export type WorkflowChangedRecords = {
  nodeIds: string[];
  nodeViewIds: string[];
  fieldIds: WorkflowFieldIdentity[];
  edgeIds: RuntimeEdgeId[];
  chatConfig: boolean;
};

export type WorkflowAffectedRecords = {
  nodeIds: string[];
  fieldIds: WorkflowFieldIdentity[];
  structure: boolean;
};

type WorkflowChangeBase = {
  origin: WorkflowChangeOrigin;
  version: number;
  transactionId: number;
};

/** 语义节点、边或 chatConfig 发生变化的事件。 */
export type WorkflowSemanticChange = DeepReadonly<
  WorkflowChangeBase & {
    kind: 'semantic';
    changedRecords: WorkflowChangedRecords;
    affectedRecords: WorkflowAffectedRecords;
  }
>;

/** 几何提交事件；瞬时 Canvas frame 不会产生此事件。 */
export type WorkflowGeometryChange = DeepReadonly<
  WorkflowChangeBase & {
    kind: 'geometry';
    changedRecords: WorkflowChangedRecords;
    affectedRecords: WorkflowAffectedRecords;
  }
>;

/** 完整 document replace 事件。 */
export type WorkflowReplaceChange = DeepReadonly<
  WorkflowChangeBase & {
    kind: 'replace';
    /** replace 是全量失效分支，数组保持为空以避免展开全部身份。 */
    changedRecords: WorkflowChangedRecords;
    affectedRecords: WorkflowAffectedRecords;
  }
>;

/** 成功事务完成所有派生状态更新后发布的一条不可变事件。 */
export type WorkflowChange =
  | WorkflowSemanticChange
  | WorkflowGeometryChange
  | WorkflowReplaceChange;

/** 运行时可接受的闭合工作流命令。Debug 与 Canvas frame 不属于该联合。 */
export type WorkflowCommand =
  | { type: 'addNode'; node: StoreNodeItemType }
  | { type: 'replaceNode'; nodeId: string; node: StoreNodeItemType }
  | { type: 'updateNode'; nodeId: string; patch: Partial<WorkflowNodeData> }
  | {
      type: 'updateField';
      nodeId: string;
      fieldKey: string;
      value: unknown;
      kind?: 'input' | 'output';
    }
  | { type: 'removeNodes'; nodeIds: string[] }
  | { type: 'connectEdge'; edge: StoreEdgeItemType }
  | {
      type: 'disconnectEdge';
      edgeId?: RuntimeEdgeId;
      edge?: StoreEdgeItemType;
      index?: number;
    }
  | { type: 'attachToContainer'; nodeId: string; containerId: string }
  | { type: 'updateChatConfig'; chatConfig: AppChatConfigType }
  | {
      type: 'commitGeometry';
      nodeId: string;
      position?: { x: number; y: number };
      isFolded?: boolean;
    }
  | { type: 'replaceDocument'; document: CanonicalWorkflowData };

/** 失败事务的结构化原因。失败不会修改任何 observable state。 */
export type WorkflowCommandError = {
  code:
    | 'disposed'
    | 'invalid_command'
    | 'not_found'
    | 'duplicate_node'
    | 'invalid_edge'
    | 'invalid_placement';
  message: string;
};

/** dispatch 的结果；拒绝命令不抛出，也不产生事件或 history。 */
export type WorkflowDispatchResult = {
  ok: boolean;
  change?: WorkflowChange;
  error?: WorkflowCommandError;
  deletedEdgeCount?: number;
};

/** Debug 启动参数，不触碰 Workflow Document 生命周期。 */
export type DebugStartOptions = {
  formValues?: Record<string, unknown>;
};

/** Workflow Runtime Port 的唯一行为测试与 adapter seam。 */
export type WorkflowRuntimePort = {
  getWorkflow: () => WorkflowSnapshot;
  getWorkflowData: () => CanonicalWorkflowData;
  getNode: (nodeId: string) => WorkflowNodeSnapshot | undefined;
  getNodeView: (nodeId: string) => WorkflowNodeViewSnapshot | undefined;
  getField: (query: WorkflowFieldQuery) => WorkflowFieldSnapshot | undefined;
  getDebug: () => DebugSessionSnapshot | undefined;
  getHistory: () => HistorySnapshot;
  getChangeLog: () => readonly WorkflowChange[];
  dispatch: (command: WorkflowCommand | readonly WorkflowCommand[]) => WorkflowDispatchResult;
  subscribe: (listener: (change: WorkflowChange) => void) => () => void;
  undo: () => WorkflowDispatchResult;
  redo: () => WorkflowDispatchResult;
  startDebug: (options?: DebugStartOptions) => DebugSessionSnapshot;
  setDebugResult: (nodeId: string, result: unknown) => void;
  finishDebug: (status?: 'success' | 'failed') => void;
  clearDebug: () => void;
  isDisposed: () => boolean;
  dispose: () => void;
};
