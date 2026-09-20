// 迁移期共享的画布类型、overlay 与投影边编码。
// 结构/几何 diff 已迁到调用点 adapter；本文件随收尾票删除。
import { omit } from 'lodash-es';
import type { Node } from 'reactflow';
import { StoreNodeItemTypeSchema } from '@fastgpt/global/core/workflow/type/node';
import type { FlowNodeItemType, StoreNodeItemType } from '@fastgpt/global/core/workflow/type/node';

export type CanvasNode = Node<FlowNodeItemType, string | undefined>;

/**
 * 只属于画布视图的数据字段：不进文档，由 host overlay 持有并在投影时合并。
 * courseUrl/userGuide 是旧路径也从不持久化的展示元信息（保存白名单会剥离），
 * 归入视图字段避免 updateNode 时被 store schema 丢弃。
 * isError/workflowCheckIssues 不在此列：问题状态由 host 问题存储持有，投影时直接合并。
 */
export const VIEW_DATA_KEYS = [
  'debugResult',
  'searchedText',
  'courseUrl',
  'readmeUrl',
  'userGuide'
] as const;
export type ViewDataKey = (typeof VIEW_DATA_KEYS)[number];

/** 单个节点的视图 overlay 变更。 */
export type ViewOverlayPatch = {
  nodeId: string;
  values: Partial<Record<ViewDataKey, unknown>>;
};

/** 画布节点 -> 严格 store 节点：剥离视图字段与模板专用字段，保留 position/isFolded。 */
export const canvasNodeToStoreNode = (node: CanvasNode): StoreNodeItemType =>
  StoreNodeItemTypeSchema.parse({
    ...omit(node.data, VIEW_DATA_KEYS as unknown as string[]),
    position: node.position
  });

export const EDGE_ID_PREFIX = 'wfedge-';

/** 投影边 id 编码 runtime 边数组下标；断连按 index 精确删除一条边。 */
export const encodeRuntimeEdgeId = (index: number) => `${EDGE_ID_PREFIX}${index}`;
/** 与 storeEdge2RenderEdge 相同的 handle 归一；值匹配删除时必须对两边同时应用。 */
export const normalizeEdgeHandles = (edge: {
  sourceHandle?: string | null;
  targetHandle?: string | null;
}) => ({
  sourceHandle: (edge.sourceHandle || '').replace(/-source-(top|bottom|left)$/, '-source-right'),
  targetHandle: (edge.targetHandle || '').replace(/-target-(top|bottom|right)$/, '-target-left')
});
