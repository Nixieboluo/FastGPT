// Runtime snapshot -> ReactFlow renderer projection.
// 画布节点 = Node Data（storeNode2FlowNode 物化）+ Node View State（位置/折叠）
// + host 标红焦点
// + host 视图 overlay（debugResult/searchedText/教程元信息）
// + renderer 交互状态（选中、拖拽、测量尺寸、层级，从本地数组保留）。
// 问题文案不进画布数组：节点组件直接读 Runtime snapshot 的 issues。
import { pick } from 'lodash-es';
import type { Edge } from 'reactflow';
import type { TFunction } from 'next-i18next';
import { EDGE_TYPE } from '@fastgpt/global/core/workflow/node/constant';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { StoreNodeItemTypeSchema } from '@fastgpt/global/core/workflow/type/node';
import type {
  WorkflowNodeSnapshot,
  WorkflowNodeViewSnapshot,
  WorkflowRuntimePort
} from '@fastgpt/global/core/workflow/editor/types';
import { storeNode2FlowNode } from '@/web/core/workflow/utils';
import {
  encodeRuntimeEdgeId,
  normalizeEdgeHandles,
  type CanvasNode,
  type ViewDataKey
} from '@/web/core/workflow/editor/canvas';

/** host 持有的按节点视图数据（不进文档）。 */
export type ViewDataOverlayMap = Record<string, Partial<Record<ViewDataKey, unknown>>>;

type NodeCacheEntry = {
  snapshot: WorkflowNodeSnapshot;
  view: WorkflowNodeViewSnapshot | undefined;
  overlay: Partial<Record<ViewDataKey, unknown>> | undefined;
  isError: boolean;
  isTool: boolean;
  selected: boolean | undefined;
  dragging: boolean | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  zIndex: number | undefined;
  posX: number;
  posY: number;
  node: CanvasNode;
};

type EdgeCacheEntry = {
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  zIndex: number | undefined;
  selected: boolean | undefined;
  edge: Edge<any>;
};

export type ProjectionCache = {
  nodes: Map<string, NodeCacheEntry>;
  edges: Map<string, EdgeCacheEntry>;
};

export const createProjectionCache = (): ProjectionCache => ({
  nodes: new Map(),
  edges: new Map()
});

/** 交互字段只在本地数组上维护；重投影时按 id 保留，避免手势中被 runtime 值覆盖。 */
const INTERACTION_FIELDS = ['selected', 'dragging', 'width', 'height', 'measured'] as const;

/**
 * 把 Runtime 当前状态投影成画布数组。
 * 带按节点缓存：runtime snapshot / view / overlay / 交互值都没变的节点复用同一对象，
 * 保证 reactflow 与节点组件不因重投影而无谓重渲染。
 * 注意：只能使用 getWorkflow/getNode/getNodeView（有版本缓存），
 * 不能用 getWorkflowData()（每次全量深拷贝）。
 */
export const projectRuntimeCanvas = ({
  runtime,
  overlays,
  errorNodeId,
  t,
  localNodes,
  localEdges,
  cache
}: {
  runtime: WorkflowRuntimePort;
  overlays: ViewDataOverlayMap;
  /** host 问题焦点节点：该节点标红并强制选中，其余节点还原本地选中态。 */
  errorNodeId?: string;
  t: TFunction;
  localNodes: CanvasNode[];
  localEdges: Edge<any>[];
  cache: ProjectionCache;
}): { nodes: CanvasNode[]; edges: Edge<any>[] } => {
  const workflow = runtime.getWorkflow();
  const toolNodeIds = new Set(
    workflow.edges
      .filter((edge) => edge.targetHandle === NodeOutputKeyEnum.selectedTools)
      .map((edge) => edge.target)
  );
  const localNodeById = new Map(localNodes.map((node) => [node.id, node]));

  const nodes = workflow.nodes.map((snapshot) => {
    const nodeId = snapshot.nodeId;
    const view = runtime.getNodeView(nodeId);
    const overlay = overlays[nodeId];
    const isError = errorNodeId === nodeId;
    const local = localNodeById.get(nodeId);
    const isTool = toolNodeIds.has(nodeId);
    const selected = local?.selected;
    const dragging = local?.dragging;
    // 拖拽中的位置以本地为准：几何要等手势结束才提交给 Runtime。
    const position = dragging && local ? local.position : (view?.position ?? { x: 0, y: 0 });
    const zIndex = snapshot.parentNodeId ? 1001 : undefined;
    const width = local?.width;
    const height = local?.height;

    const cached = cache.nodes.get(nodeId);
    if (
      cached &&
      cached.snapshot === snapshot &&
      cached.view === view &&
      cached.overlay === overlay &&
      cached.isError === isError &&
      cached.isTool === isTool &&
      cached.selected === selected &&
      cached.dragging === dragging &&
      cached.width === width &&
      cached.height === height &&
      cached.zIndex === zIndex &&
      cached.posX === position.x &&
      cached.posY === position.y
    ) {
      return cached.node;
    }

    const flowNode = storeNode2FlowNode({
      // StoreNodeItemType 不含 issues，parse 会自然剥掉 Issue View 字段。
      item: StoreNodeItemTypeSchema.parse({ ...snapshot, position }),
      isTool,
      t
    });
    // isFolded 存在 Node View 上（语义快照不含），投影时合并，否则折叠状态在画布上丢失。
    const data = {
      ...flowNode.data,
      isFolded: view?.isFolded,
      ...overlay,
      ...(isError ? { isError: true } : {})
    } as typeof flowNode.data;
    const node: CanvasNode = {
      ...flowNode,
      data,
      position,
      selected,
      zIndex,
      ...(local ? pick(local, [...INTERACTION_FIELDS]) : {}),
      // 标红焦点节点保持选中：与旧 onUpdateNodeError 一致，定位后无需再点一次即可操作该节点。
      ...(isError ? { selected: true } : {})
    };

    cache.nodes.set(nodeId, {
      snapshot,
      view,
      overlay,
      isError,
      isTool,
      selected,
      dragging,
      width,
      height,
      zIndex,
      posX: position.x,
      posY: position.y,
      node
    });
    return node;
  });

  const aliveNodeIds = new Set(nodes.map((node) => node.id));
  cache.nodes.forEach((_, nodeId) => {
    if (!aliveNodeIds.has(nodeId)) cache.nodes.delete(nodeId);
  });

  const childNodeIds = new Set(
    workflow.nodes.filter((node) => node.parentNodeId).map((node) => node.nodeId)
  );
  const localEdgeById = new Map(localEdges.map((edge) => [edge.id, edge]));

  const edges = workflow.edges.map((edge, index) => {
    const id = encodeRuntimeEdgeId(index);
    const { sourceHandle, targetHandle } = normalizeEdgeHandles(edge);
    const zIndex = childNodeIds.has(edge.source) ? 1001 : undefined;
    const selected = localEdgeById.get(id)?.selected;

    const cached = cache.edges.get(id);
    if (
      cached &&
      cached.source === edge.source &&
      cached.target === edge.target &&
      cached.sourceHandle === sourceHandle &&
      cached.targetHandle === targetHandle &&
      cached.zIndex === zIndex &&
      cached.selected === selected
    ) {
      return cached.edge;
    }

    const next: Edge<any> = {
      id,
      source: edge.source,
      target: edge.target,
      sourceHandle,
      targetHandle,
      type: EDGE_TYPE,
      ...(selected !== undefined ? { selected } : {}),
      ...(zIndex !== undefined ? { zIndex } : {})
    };
    cache.edges.set(id, {
      source: edge.source,
      target: edge.target,
      sourceHandle,
      targetHandle,
      zIndex,
      selected,
      edge: next
    });
    return next;
  });

  // 删除边会使后续 wfedge-N 下标整体前移，缓存按 id 命中不了新值时重建即可，但要清掉越界 id。
  if (cache.edges.size > edges.length) {
    for (let i = edges.length; ; i++) {
      const id = encodeRuntimeEdgeId(i);
      if (!cache.edges.delete(id)) break;
    }
  }

  return { nodes, edges };
};
