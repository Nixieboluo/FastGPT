import type { CanonicalWorkflowData } from '../../migration/schema';
import type { FlowNodeInputItemType, FlowNodeOutputItemType } from '../../type/io';
import type { WorkflowCheckIssue } from '../../type/node';
import type {
  DebugSessionSnapshot,
  DebugStartOptions,
  WorkflowChange,
  WorkflowAffectedRecords,
  WorkflowChangedRecords,
  WorkflowCommand,
  WorkflowCommandError,
  WorkflowDispatchResult,
  WorkflowEdgeSnapshot,
  WorkflowFieldIdentity,
  WorkflowFieldQuery,
  WorkflowFieldSnapshot,
  WorkflowNodeSnapshot,
  WorkflowRuntimePort,
  WorkflowSnapshot
} from '../types';
import {
  addFieldIdentity,
  cloneValue,
  freezeValue,
  getError,
  getFieldIdentityKey,
  isObject
} from './kernel';
import { createDocumentModule, documentToCanonical } from './documentModule';
import { createNodeViewModule } from './nodeViewModule';
import { createReferenceModule } from './referenceModule';
import { createIssueModule } from './issueModule';
import {
  createHistoryModule,
  createGeometryHistoryEntry,
  createHistoryEntry,
  materializeHistoryDocument
} from './historyModule';
import type {
  GeometryCommand,
  MutationMeta,
  NodeRecord,
  RuntimeDocument,
  TransactionContext
} from './types';

/**
 * Runtime Core：只负责事务编排、revision/transaction 身份、原子提交、单次派生、
 * WorkflowChange 组装、订阅发布、释放，以及手写 public Port 装配。
 * 领域规则全部在 Document / NodeView / Reference / Issue / History module 内。
 */

const MAX_CHANGE_LOG = 100;

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

/** 从 strict canonical fixture 创建 Workflow Runtime Port。 */
export const createWorkflowEditor = (
  strictCanonicalData: CanonicalWorkflowData
): WorkflowRuntimePort => {
  // 固定依赖顺序：Document -> NodeView -> Reference -> Issue -> History。
  const document = createDocumentModule(strictCanonicalData);
  const nodeView = createNodeViewModule(document);
  const reference = createReferenceModule(document);
  const issue = createIssueModule({ document, reference });
  const history = createHistoryModule();

  let disposed = false;
  let workflowVersion = 0;
  let semanticVersion = 0;
  let transactionId = 0;
  let debugVersion = 0;
  let debugSequence = 0;
  let debugSession: DebugSessionSnapshot | undefined;
  const listeners = new Set<(change: WorkflowChange) => void>();
  const changeLog: WorkflowChange[] = [];
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
      snapshot: WorkflowFieldSnapshot;
    }
  >();
  let workflowSnapshotCache: { version: number; snapshot: WorkflowSnapshot } | undefined;
  let debugSnapshotCache: { version: number; snapshot: DebugSessionSnapshot } | undefined;

  const ensureActive = () => {
    if (disposed) throw new Error('Workflow editor has been disposed');
  };

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

  const invalidateFieldCaches = (fields: Iterable<WorkflowFieldIdentity>) => {
    const list = [...fields];
    reference.invalidateFieldStatuses(list);
    list.forEach((field) => fieldSnapshotCache.delete(getFieldIdentityKey(field)));
  };

  const pruneSnapshotCaches = () => {
    nodeSnapshotCache.forEach((cached, nodeId) => {
      const current = document.getNodeById(nodeId);
      if (!current || cached.record.data !== current.data) nodeSnapshotCache.delete(nodeId);
    });
    nodeView.pruneSnapshotCache();
  };

  /** 返回 Node Data scoped snapshot，并仅缓存当前 Node Data 与 Issue 数组。 */
  const getNodeSnapshot = (nodeId: string): WorkflowNodeSnapshot | undefined => {
    ensureActive();
    const node = document.getNodeById(nodeId);
    if (!node) return undefined;
    const issues = issue.getNodeIssues(nodeId);
    const cached = nodeSnapshotCache.get(nodeId);
    if (cached?.record.data === node.data && cached.issues === issues) return cached.snapshot;
    const snapshot = freezeValue({
      ...cloneValue(node.data),
      issues: cloneValue(issues)
    }) as WorkflowNodeSnapshot;
    nodeSnapshotCache.set(nodeId, { record: node, issues, snapshot });
    return snapshot;
  };

  /** 返回 workflow scoped snapshot；版本不变时保持对象身份稳定。 */
  const getWorkflowSnapshot = (): WorkflowSnapshot => {
    ensureActive();
    if (workflowSnapshotCache?.version === semanticVersion) return workflowSnapshotCache.snapshot;
    const current = document.getDocument();
    const snapshot = freezeValue({
      nodes: current.nodes.map((node) => getNodeSnapshot(node.data.nodeId)!),
      edges: current.edges.map((edge) => cloneValue(edge.data)) as WorkflowEdgeSnapshot[],
      chatConfig: cloneValue(current.chatConfig),
      issues: Array.from(issue.getIssuesByNode().values()).flatMap((issues) => cloneValue(issues))
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
    const node = document.getNodeById(nodeId);
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

    const statuses = input ? reference.getFieldStatuses(nodeId, input) : [];
    const referenceOptions = input ? reference.getReferenceOptions(nodeId, input) : [];
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
      snapshot
    });
    return snapshot;
  };

  /** 扁平命令路由：geometry 交给 NodeView，其余交给 Document。 */
  const applyCommand = (ctx: TransactionContext, command: WorkflowCommand) => {
    if (command.type === 'commitGeometry') nodeView.reduceGeometryCommand(ctx, command);
    else document.reduceCommand(ctx, command);
  };

  /** 纯 geometry 事务只改 Node View、history 和事件，跳过语义派生状态。 */
  const dispatchGeometry = (commands: readonly GeometryCommand[]): WorkflowDispatchResult => {
    const meta = createMutationMeta('geometry');
    const staged = nodeView.stageGeometryBatch(commands, meta);
    if (!staged.ok) return { ok: false, error: staged.error };
    if (!staged.nodeChanges) return { ok: true };

    const before = document.getDocument();
    document.commitNodeRecords(staged.nodeChanges);
    const after = document.getDocument();
    workflowVersion++;

    const change = makeChange(meta, 'command');
    history.push(
      createGeometryHistoryEntry({ before, after, nodeChanges: staged.nodeChanges, change })
    );
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
      return dispatchGeometry(list as readonly GeometryCommand[]);
    }
    const before = document.getDocument();
    const beforeNextEdgeId = document.getNextEdgeId();
    const beforeReferenceGraph = reference.getGraph();
    const workingReferenceGraph = reference.forkGraph();
    const working: RuntimeDocument = {
      nodes: before.nodes.slice(),
      edges: before.edges.slice(),
      chatConfig: before.chatConfig
    };
    const meta = createMutationMeta();
    const ctx: TransactionContext = { working, meta, referenceGraph: workingReferenceGraph };
    try {
      list.forEach((command) => applyCommand(ctx, command));
      if (list.some((command) => command.type === 'connectEdge')) {
        document.applyWorkflowStartAutoFill(ctx);
      }
    } catch (error) {
      document.setNextEdgeId(beforeNextEdgeId);
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
      document.setNextEdgeId(beforeNextEdgeId);
      return { ok: true };
    }

    meta.structureChanged = document.resolveStructureChanged(meta);
    document.setDocument(working);
    workflowVersion++;
    if (meta.kind !== 'geometry') semanticVersion++;
    if (meta.kind === 'replace') {
      document.rebuildNodeIndex();
      document.rebuildGraphIndex();
      document.rebuildWorkflowStartIds();
      reference.rebuildGraph();
      issue.rebuildIssues();
      reference.pruneFieldStatusCache();
      fieldSnapshotCache.clear();
    } else {
      document.updateNodeIndexIncrementally(meta);
      document.updateGraphIndexIncrementally(meta);
      document.updateWorkflowStartIndex(meta);
      // 单次派生按 Document -> Reference -> Issue 顺序执行；issue 候选集合必须在引用派生
      // 之前收集，才能保证 affected records 的排列与派生顺序一致。
      const issueNodeIds = issue.collectTransactionNodeIds(meta);
      const cacheOnlyFieldIds = reference.commitTransaction({
        meta,
        stagedGraph: workingReferenceGraph,
        beforeGraph: beforeReferenceGraph
      });
      document.addAffectedStructure(meta);
      invalidateFieldCaches([
        ...meta.changedFieldIds.values(),
        ...cacheOnlyFieldIds.values(),
        ...reference.getStructureInvalidationFields(meta)
      ]);
      issue.rebuildForTransaction({ meta, candidateNodeIds: issueNodeIds });
    }
    const change = makeChange(meta, 'command');
    history.push(createHistoryEntry({ before, after: document.getDocument(), change }));
    pruneSnapshotCaches();
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
    const entry = history.take(direction);
    if (!entry) return { ok: false, error: getError('invalid_command', `Nothing to ${direction}`) };
    const originalChange = entry.change;
    const previousIssues = issue.getIssuesByNode();
    document.setDocument(
      materializeHistoryDocument({ current: document.getDocument(), entry, direction })
    );
    workflowVersion++;
    if (originalChange.kind === 'geometry') {
      document.refreshNodeIndexRecords(originalChange.changedRecords.nodeViewIds);
    } else {
      document.rebuildNodeIndex();
      semanticVersion++;
      document.rebuildGraphIndex();
      document.rebuildWorkflowStartIds();
      reference.clearFieldStatusCache();
      issue.rebuildIssues();
      reference.rebuildGraph();
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
      issue.addChangedIssueRecords(
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

  issue.rebuildIssues();

  const port: WorkflowRuntimePort = {
    getWorkflow: getWorkflowSnapshot,
    /** 返回不含 runtime-only state 的 canonical 深拷贝；runtime disposed 后拒绝读取。 */
    getWorkflowData: () => {
      ensureActive();
      return cloneValue(documentToCanonical(document.getDocument()));
    },
    getNode: (nodeId) => getNodeSnapshot(nodeId),
    getNodeView: (nodeId) => {
      ensureActive();
      return nodeView.getNodeViewSnapshot(nodeId);
    },
    getField: getFieldSnapshot,
    getDebug: getDebugSnapshot,
    getHistory: () => history.getSnapshot(),
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
        workflow: cloneValue(documentToCanonical(document.getDocument())),
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
      history.clear();
      nodeSnapshotCache.clear();
      fieldSnapshotCache.clear();
      workflowSnapshotCache = undefined;
      debugSnapshotCache = undefined;
      debugSession = undefined;
      nodeView.clear();
      reference.clear();
      issue.clear();
      document.clear();
    }
  };

  return port;
};
