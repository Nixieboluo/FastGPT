// [workflow-runtime-cutover] 临时兼容桥：把旧 Context 的写路径翻译成 Workflow Runtime 命令。
// 翻转期旧调用点不改，全部语义写入经这里进入 Runtime；迁移结束后整个 cutover 目录删除。
import { isEqual, omit } from 'lodash-es';
import type { Edge, Node, NodeChange } from 'reactflow';
import { StoreNodeItemTypeSchema } from '@fastgpt/global/core/workflow/type/node';
import type { FlowNodeItemType, StoreNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import type { StoreEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import type { WorkflowCommand } from '@fastgpt/global/core/workflow/editor/types';

export type CanvasNode = Node<FlowNodeItemType, string | undefined>;

/**
 * 只属于画布视图的数据字段：不进文档，由 host overlay 持有并在投影时合并。
 * courseUrl/userGuide 是旧路径也从不持久化的展示元信息（保存白名单会剥离），
 * 归入视图字段避免 updateNode 时被 store schema 丢弃。
 */
export const VIEW_DATA_KEYS = [
  'isError',
  'workflowCheckIssues',
  'debugResult',
  'searchedText',
  'courseUrl',
  'userGuide'
] as const;
export type ViewDataKey = (typeof VIEW_DATA_KEYS)[number];

/** 单个节点的视图 overlay 变更。 */
export type ViewOverlayPatch = {
  nodeId: string;
  values: Partial<Record<ViewDataKey, unknown>>;
};

export type NodeDiffResult = {
  commands: WorkflowCommand[];
  viewPatches: ViewOverlayPatch[];
  /** replaceInput/addInput/addOutput 命中重复 key；由调用方 toast，与旧行为一致。 */
  duplicateKeyNodeIds: string[];
};

const STORE_NODE_KEYS = new Set(Object.keys(StoreNodeItemTypeSchema.shape));

const semanticData = (data: FlowNodeItemType) =>
  omit(data, [...VIEW_DATA_KEYS, 'isFolded']) as Record<string, unknown>;

/** 画布节点 -> 严格 store 节点：剥离视图字段与模板专用字段，保留 position/isFolded。 */
export const canvasNodeToStoreNode = (node: CanvasNode): StoreNodeItemType =>
  StoreNodeItemTypeSchema.parse({
    ...omit(node.data, VIEW_DATA_KEYS as unknown as string[]),
    position: node.position
  });

const pickStorePatch = (patch: Record<string, unknown>): Partial<StoreNodeItemType> => {
  const result: Record<string, unknown> = {};
  Object.entries(patch).forEach(([key, value]) => {
    if (STORE_NODE_KEYS.has(key)) result[key] = value;
  });
  return result as Partial<StoreNodeItemType>;
};

const positionsEqual = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
  a?.x === b?.x && a?.y === b?.y;

/**
 * 比较前后画布节点数组，把语义差异翻译成 Runtime 命令。
 * selected/measured/zIndex 等交互字段不进命令，由 renderer 本地状态持有。
 */
export const diffCanvasNodes = ({
  prev,
  next
}: {
  prev: CanvasNode[];
  next: CanvasNode[];
}): NodeDiffResult => {
  const commands: WorkflowCommand[] = [];
  const viewPatches: ViewOverlayPatch[] = [];
  const prevMap = new Map(prev.map((node) => [node.data.nodeId, node]));
  const nextMap = new Map(next.map((node) => [node.data.nodeId, node]));

  const removedIds = prev
    .filter((node) => !nextMap.has(node.data.nodeId))
    .map((node) => node.data.nodeId);
  if (removedIds.length > 0) {
    commands.push({ type: 'removeNodes', nodeIds: removedIds });
  }

  next.forEach((node) => {
    const previous = prevMap.get(node.data.nodeId);
    if (!previous) {
      commands.push({ type: 'addNode', node: canvasNodeToStoreNode(node) });
      return;
    }
    if (previous === node) return;

    // 视图字段差异 -> overlay
    const values: Partial<Record<ViewDataKey, unknown>> = {};
    let hasViewChange = false;
    VIEW_DATA_KEYS.forEach((key) => {
      if (!isEqual(previous.data[key], node.data[key])) {
        values[key] = node.data[key];
        hasViewChange = true;
      }
    });
    if (hasViewChange) viewPatches.push({ nodeId: node.data.nodeId, values });

    // 折叠与位置 -> 几何提交
    if (!!previous.data.isFolded !== !!node.data.isFolded) {
      commands.push({
        type: 'commitGeometry',
        nodeId: node.data.nodeId,
        isFolded: !!node.data.isFolded
      });
    }
    if (!positionsEqual(previous.position, node.position)) {
      commands.push({
        type: 'commitGeometry',
        nodeId: node.data.nodeId,
        position: { x: node.position.x, y: node.position.y }
      });
    }

    // 其余语义字段 -> 节点更新
    const prevSemantic = semanticData(previous.data);
    const nextSemantic = semanticData(node.data);
    const patch: Record<string, unknown> = {};
    let hasSemanticChange = false;
    Object.keys(nextSemantic).forEach((key) => {
      if (!isEqual(prevSemantic[key], nextSemantic[key])) {
        patch[key] = nextSemantic[key];
        hasSemanticChange = true;
      }
    });
    Object.keys(prevSemantic).forEach((key) => {
      if (!(key in nextSemantic)) {
        patch[key] = undefined;
        hasSemanticChange = true;
      }
    });
    if (hasSemanticChange) {
      const storePatch = pickStorePatch(patch) as Record<string, unknown>;
      // 容器归属变化必须走 attach 命令（placement 校验 + 非法边清理），不走普通更新。
      const parentChanged =
        'parentNodeId' in storePatch && prevSemantic.parentNodeId !== storePatch.parentNodeId;
      delete storePatch.parentNodeId;
      if (Object.keys(storePatch).length > 0) {
        commands.push({
          type: 'updateNode',
          nodeId: node.data.nodeId,
          patch: storePatch as Partial<StoreNodeItemType>
        });
      }
      if (parentChanged && patch.parentNodeId !== undefined) {
        commands.push({
          type: 'attachToContainer',
          nodeId: node.data.nodeId,
          containerId: String(patch.parentNodeId)
        });
      }
    }
  });

  return { commands, viewPatches, duplicateKeyNodeIds: [] };
};

export const EDGE_ID_PREFIX = 'wfedge-';

/** 投影边 id 编码 runtime 边数组下标；断连按 index 精确删除一条边。 */
export const encodeRuntimeEdgeId = (index: number) => `${EDGE_ID_PREFIX}${index}`;
export const decodeRuntimeEdgeId = (id?: string | null): number | undefined => {
  if (!id?.startsWith(EDGE_ID_PREFIX)) return undefined;
  const index = Number(id.slice(EDGE_ID_PREFIX.length));
  return Number.isInteger(index) ? index : undefined;
};

/** 与 storeEdge2RenderEdge 相同的 handle 归一；值匹配删除时必须对两边同时应用。 */
export const normalizeEdgeHandles = (edge: {
  sourceHandle?: string | null;
  targetHandle?: string | null;
}) => ({
  sourceHandle: (edge.sourceHandle || '').replace(/-source-(top|bottom|left)$/, '-source-right'),
  targetHandle: (edge.targetHandle || '').replace(/-target-(top|bottom|right)$/, '-target-left')
});

const edgeValueEquals = (
  a: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  b: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }
) => {
  const na = normalizeEdgeHandles(a);
  const nb = normalizeEdgeHandles(b);
  return (
    a.source === b.source &&
    a.target === b.target &&
    na.sourceHandle === nb.sourceHandle &&
    na.targetHandle === nb.targetHandle
  );
};

/**
 * 把待删除的画布边解析成 runtime 边数组的当前下标。
 * 必须按值匹配而不是信任画布 id 里编码的旧下标：同一 tick 里前一个命令
 * （如 removeNodes 级联删边）提交后，画布数组还没有重投影，id 下标已失效。
 * 值相同的重复边命中第一条即可（删除任意一条语义等价）；runtime 已不存在的边跳过。
 */
export const resolveRemovedEdgeIndexes = ({
  removed,
  runtimeEdges
}: {
  removed: {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }[];
  runtimeEdges: readonly StoreEdgeItemType[];
}): number[] => {
  const indexes = new Set<number>();
  removed.forEach((edge) => {
    const index = runtimeEdges.findIndex((item) => edgeValueEquals(item, edge));
    if (index >= 0) indexes.add(index);
  });
  return [...indexes].sort((a, b) => b - a);
};

/**
 * 比较前后画布边数组：新增 -> connectEdge；删除 -> disconnectEdge（按 index 降序，
 * 保证同一批命令里前面的删除不影响后面的下标）。zIndex 等交互字段忽略。
 */
export const diffCanvasEdges = ({
  prev,
  next,
  runtimeEdges
}: {
  prev: Edge<any>[];
  next: Edge<any>[];
  runtimeEdges: readonly StoreEdgeItemType[];
}): WorkflowCommand[] => {
  const commands: WorkflowCommand[] = [];
  const prevIds = new Set(prev.map((edge) => edge.id));
  const nextIds = new Set(next.map((edge) => edge.id));

  next.forEach((edge) => {
    if (prevIds.has(edge.id)) return;
    if (decodeRuntimeEdgeId(edge.id) !== undefined) return;
    commands.push({
      type: 'connectEdge',
      edge: {
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle || '',
        targetHandle: edge.targetHandle || ''
      }
    });
  });

  const removedIndexes = resolveRemovedEdgeIndexes({
    removed: prev.filter((edge) => !nextIds.has(edge.id)),
    runtimeEdges
  });
  removedIndexes.forEach((index) => {
    commands.push({ type: 'disconnectEdge', index });
  });

  return commands;
};

/** reactflow remove 变更 -> removeNodes（级联与守卫由 Runtime 负责）。 */
export const translateNodeRemoveChanges = (changes: NodeChange[]): WorkflowCommand[] => {
  const nodeIds = changes.filter((change) => change.type === 'remove').map((change) => change.id);
  return nodeIds.length > 0 ? [{ type: 'removeNodes', nodeIds }] : [];
};

/** 拖拽结束帧 -> 批量几何提交；change 无 position 时回退读本地最新位置。 */
export const translateDragEndChanges = ({
  changes,
  getPosition
}: {
  changes: NodeChange[];
  getPosition: (nodeId: string) => { x: number; y: number } | undefined;
}): WorkflowCommand[] => {
  const commands: WorkflowCommand[] = [];
  changes.forEach((change) => {
    if (change.type !== 'position' || change.dragging) return;
    const position = change.position ?? getPosition(change.id);
    if (!position) return;
    commands.push({
      type: 'commitGeometry',
      nodeId: change.id,
      position: { x: position.x, y: position.y }
    });
  });
  return commands;
};

/**
 * reactflow 边删除变更 -> disconnectEdge。
 * 按值解析当前下标（同批 removeNodes 可能已级联删除，画布 id 里的下标不可信）；
 * runtime 已不存在的边直接忽略。
 */
export const translateEdgeRemoveChanges = ({
  ids,
  localEdges,
  runtimeEdges
}: {
  ids: string[];
  localEdges: Edge<any>[];
  runtimeEdges: readonly StoreEdgeItemType[];
}): WorkflowCommand[] => {
  const idSet = new Set(ids);
  const removed = localEdges.filter((edge) => idSet.has(edge.id));
  return resolveRemovedEdgeIndexes({ removed, runtimeEdges }).map((index) => ({
    type: 'disconnectEdge' as const,
    index
  }));
};
