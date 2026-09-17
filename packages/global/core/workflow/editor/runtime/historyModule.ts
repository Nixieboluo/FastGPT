import type { HistorySnapshot, WorkflowChange } from '../types';
import { freezeValue } from './kernel';
import type { HistoryEntry, NodeRecordChange, RuntimeDocument } from './types';

/**
 * History module：拥有 past/future 记录、replay 物化与有界历史。
 * replay 复用正常派生路径，不追加新的 history entry。
 */

/** ponytail: keep history bounded; raise only after measuring a real undo-depth need. */
const MAX_HISTORY = 100;

/** 保留事务前后浅数组快照；节点记录本身保持共享，避免提交时扫描整个 document。 */
export const createHistoryEntry = ({
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

/** 纯 geometry 事务的 delta 记录：只保存节点记录变化，边与 chatConfig 未参与本笔事务。 */
export const createGeometryHistoryEntry = ({
  before,
  after,
  nodeChanges,
  change
}: {
  before: RuntimeDocument;
  after: RuntimeDocument;
  nodeChanges: NodeRecordChange[];
  change: WorkflowChange;
}): HistoryEntry => ({
  kind: 'delta',
  beforeNodeCount: before.nodes.length,
  afterNodeCount: after.nodes.length,
  nodeChanges,
  beforeEdgeCount: before.edges.length,
  afterEdgeCount: after.edges.length,
  edgeChanges: [],
  change
});

/** 用 history delta 还原目标文档，保留未改记录的原始引用。 */
export const materializeHistoryDocument = ({
  current,
  entry,
  direction
}: {
  current: RuntimeDocument;
  entry: HistoryEntry;
  direction: 'undo' | 'redo';
}): RuntimeDocument => {
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

/** Create the Workflow History module. */
export const createHistoryModule = () => {
  const past: HistoryEntry[] = [];
  const future: HistoryEntry[] = [];

  /** 记录一笔已提交事务；超出上限丢弃最旧记录，并清空 redo 分支。 */
  const push = (entry: HistoryEntry) => {
    past.push(entry);
    if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
    future.length = 0;
  };

  /** 取出一条记录并搬到对侧栈；无记录时返回 undefined，由 Core 转成失败结果。 */
  const take = (direction: 'undo' | 'redo'): HistoryEntry | undefined => {
    const source = direction === 'undo' ? past : future;
    const target = direction === 'undo' ? future : past;
    const entry = source.pop();
    if (!entry) return undefined;
    target.push(entry);
    return entry;
  };

  /** 读取 history 的可观察计数，不暴露可逆操作记录。 */
  const getSnapshot = (): HistorySnapshot =>
    freezeValue({
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      undoCount: past.length,
      redoCount: future.length
    }) as HistorySnapshot;

  const clear = () => {
    past.length = 0;
    future.length = 0;
  };

  return { push, take, getSnapshot, clear };
};
