import type { NodeViewState, WorkflowCommandError, WorkflowNodeViewSnapshot } from '../types';
import { cloneValue, freezeValue, getError, isObject, valuesEqual } from './kernel';
import type {
  DocumentReadApi,
  GeometryCommand,
  GeometryStageResult,
  MutationMeta,
  NodeRecord,
  NodeRecordChange,
  TransactionContext
} from './types';

/**
 * Node View module：拥有 position/isFolded 的合并规则、geometry 命令校验与 reduce，
 * 以及 Node View scoped snapshot 缓存。
 *
 * 首版仍沿用 `NodeRecord = { data, view }` 表示，因此 geometry reduce 与 Document
 * 共同产出同一份 staged `next nodes`；view 存储拆分属于后续独立变更。
 */

export const mergeNodeView = ({
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
const validateGeometryCommand = (command: GeometryCommand): WorkflowCommandError | undefined => {
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

/** Create the Workflow Node View module. */
export const createNodeViewModule = (document: DocumentReadApi) => {
  const nodeViewSnapshotCache = new Map<
    string,
    { view: NodeViewState; snapshot: WorkflowNodeViewSnapshot }
  >();

  /** 混合事务中的 geometry reduce：只改 staged nodes 里的 view 部分。 */
  const reduceGeometryCommand = (
    { working, meta }: TransactionContext,
    command: GeometryCommand
  ) => {
    const validationError = validateGeometryCommand(command);
    if (validationError) throw validationError;
    const index = document.getWorkingNodeIndex({ working, nodeId: command.nodeId, meta });
    if (index < 0) throw getError('not_found', `Node not found: ${command.nodeId}`);
    const current = working.nodes[index];
    const nextView = mergeNodeView({
      current: current.view,
      position: command.position,
      isFolded: command.isFolded
    });
    const viewChanged = !valuesEqual(current.view, nextView);
    working.nodes = working.nodes.slice();
    working.nodes[index] = { data: current.data, view: nextView };
    if (viewChanged) meta.changedNodeViewIds.add(command.nodeId);
  };

  /**
   * 纯 geometry 事务的 staging：只读已提交 document，返回待提交记录，并把变更登记到传入的 meta。
   * 不写 Document 或 Node View 自身状态，提交与发布由 Runtime Core 负责。
   * 没有实际变化时返回空 nodeChanges，由 Runtime Core 转成 no-op 结果。
   */
  const stageGeometryBatch = (
    commands: readonly GeometryCommand[],
    meta: MutationMeta
  ): GeometryStageResult => {
    const nodeIndex = document.getNodeIndex();
    const nextViews = new Map<string, NodeViewState>();

    for (const command of commands) {
      const indexedNode = nodeIndex.get(command.nodeId);
      if (!indexedNode) {
        return { ok: false, error: getError('not_found', `Node not found: ${command.nodeId}`) };
      }
      const validationError = validateGeometryCommand(command);
      if (validationError) return { ok: false, error: validationError };

      const currentView = nextViews.get(command.nodeId) ?? indexedNode.record.view;
      nextViews.set(
        command.nodeId,
        mergeNodeView({
          current: currentView,
          position: command.position,
          isFolded: command.isFolded
        })
      );
    }

    const nodeChanges: NodeRecordChange[] = [];
    nextViews.forEach((nextView, nodeId) => {
      const indexedNode = nodeIndex.get(nodeId);
      if (!indexedNode || valuesEqual(indexedNode.record.view, nextView)) return;
      const after: NodeRecord = { data: indexedNode.record.data, view: nextView };
      nodeChanges.push({ index: indexedNode.index, before: indexedNode.record, after });
      meta.changedNodeViewIds.add(nodeId);
    });
    return { ok: true, ...(nodeChanges.length > 0 ? { nodeChanges } : {}) };
  };

  /** 返回 Node View State scoped snapshot；同一视图记录保持对象身份稳定。 */
  const getNodeViewSnapshot = (nodeId: string): WorkflowNodeViewSnapshot | undefined => {
    const node = document.getNodeById(nodeId);
    if (!node) return undefined;
    const cached = nodeViewSnapshotCache.get(nodeId);
    if (cached?.view === node.view) return cached.snapshot;
    const snapshot = freezeValue(cloneValue(node.view)) as WorkflowNodeViewSnapshot;
    nodeViewSnapshotCache.set(nodeId, { view: node.view, snapshot });
    return snapshot;
  };

  /** 丢弃 view 记录已被替换的缓存项，保持 snapshot identity 与当前状态一致。 */
  const pruneSnapshotCache = () => {
    nodeViewSnapshotCache.forEach((cached, nodeId) => {
      const current = document.getNodeById(nodeId);
      if (!current || cached.view !== current.view) nodeViewSnapshotCache.delete(nodeId);
    });
  };

  const clear = () => nodeViewSnapshotCache.clear();

  return {
    reduceGeometryCommand,
    stageGeometryBatch,
    getNodeViewSnapshot,
    pruneSnapshotCache,
    clear
  };
};
