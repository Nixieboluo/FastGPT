// [workflow-runtime-cutover] 临时兼容桥：本 Context 只剩「投影供数 + 写路径翻译」。
// Runtime 拥有唯一的 Workflow Document / Node View；派生索引直接读 Runtime 结构快照与
// 节点视图，画布数组只承载 reactflow 交互状态（拖拽帧、测量尺寸、层级）。
// 旧调用点的 setNodes/setEdges/onNodesChange/onEdgesChange 仍在这里翻译成 Runtime 命令，
// 迁移结束后薄壳随调用点改造删除。
import type {
  FlowNodeItemType,
  FlowNodeTemplateType
} from '@fastgpt/global/core/workflow/type/node';
import { createContext, useContextSelector } from 'use-context-selector';

import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import type {
  WorkflowCommand,
  WorkflowRuntimePort,
  WorkflowSnapshot
} from '@fastgpt/global/core/workflow/editor/types';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';
import { useMemoizedFn } from 'ahooks';
import { useTranslation } from 'next-i18next';
import React, {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  applyEdgeChanges,
  applyNodeChanges
} from 'reactflow';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import {
  createProjectionCache,
  projectRuntimeCanvas
} from '@/web/core/workflow/editor/cutover/projection';
import {
  diffCanvasEdges,
  diffCanvasNodes,
  translateDragEndChanges,
  translateEdgeRemoveChanges,
  translateNodeRemoveChanges,
  type CanvasNode
} from '@/web/core/workflow/editor/cutover/translate';

type OnChange<ChangesType> = (changes: ChangesType[]) => void;

type WorkflowNodeContextType = {
  nodes: Node<FlowNodeItemType, string | undefined>[];
  rawNodesMap: Record<string, Node<FlowNodeItemType, string | undefined>>;
  getRawNodeById: (
    nodeId: string | null | undefined
  ) => Node<FlowNodeItemType, string | undefined> | undefined;
};
export const WorkflowInitContext = createContext<WorkflowNodeContextType>({
  nodes: [],
  rawNodesMap: {},
  getRawNodeById: function (
    nodeId: string | null | undefined
  ): Node<FlowNodeItemType, string | undefined> | undefined {
    throw new Error('Function not implemented.');
  }
});

export type WorkflowDataContextType = {
  basicNodeTemplates: FlowNodeTemplateType[];
  workflowStartNode: FlowNodeItemType | undefined;
  allNodeFolded: boolean;
  hasToolNode: boolean;
  hasLoopRunNode: boolean;
  toolNodesMap: Record<string, boolean>;
  nodeIds: string[];
  nodeAmount: number;
  foldedNodesMap: Record<string, boolean>;
  getNodeById: (
    nodeId: string | null | undefined,
    condition?: (node: FlowNodeItemType) => boolean
  ) => FlowNodeItemType | undefined;
  setNodes: Dispatch<SetStateAction<Node<FlowNodeItemType, string | undefined>[]>>;
  onNodesChange: OnChange<NodeChange>;
  getNodes: () => Node<FlowNodeItemType, string | undefined>[];
  getNodeList: () => FlowNodeItemType[];
  edges: Edge<any>[];
  setEdges: Dispatch<SetStateAction<Edge<any>[]>>;
  onEdgesChange: OnChange<EdgeChange>;
  forbiddenSaveSnapshot: React.MutableRefObject<boolean>;

  childrenNodeIdListMap: Record<string, string[]>;
};
export const WorkflowBufferDataContext = createContext<WorkflowDataContextType>({
  basicNodeTemplates: [],
  workflowStartNode: undefined,
  allNodeFolded: false,
  hasToolNode: false,
  hasLoopRunNode: false,
  toolNodesMap: {},
  nodeIds: [],
  nodeAmount: 0,
  foldedNodesMap: {},
  getNodeById: function (nodeId: string | null | undefined): FlowNodeItemType | undefined {
    throw new Error('Function not implemented.');
  },
  setNodes: function (
    value: React.SetStateAction<Node<FlowNodeItemType, string | undefined>[]>
  ): void {
    throw new Error('Function not implemented.');
  },
  onNodesChange: function (changes: NodeChange[]): void {
    throw new Error('Function not implemented.');
  },
  getNodes: function (): Node<FlowNodeItemType, string | undefined>[] {
    throw new Error('Function not implemented.');
  },
  getNodeList: function (): FlowNodeItemType[] {
    throw new Error('Function not implemented.');
  },
  edges: [],
  setEdges: function (value: React.SetStateAction<Edge<any>[]>): void {
    throw new Error('Function not implemented.');
  },
  onEdgesChange: function (changes: EdgeChange[]): void {
    throw new Error('Function not implemented.');
  },
  forbiddenSaveSnapshot: { current: false },

  childrenNodeIdListMap: {}
});

/** 只依赖节点身份/类型与连线的结构索引；不读节点视图，也不物化 FlowNodeItemType。 */
type StructureIndexes = {
  nodeIds: string[];
  nodeAmount: number;
  childrenNodeIdListMap: Record<string, string[]>;
  toolNodesMap: Record<string, boolean>;
  workflowStartNodeId: string | undefined;
  hasToolNode: boolean;
  hasLoopRunNode: boolean;
};

const EMPTY_STRUCTURE_INDEXES: StructureIndexes = {
  nodeIds: [],
  nodeAmount: 0,
  childrenNodeIdListMap: {},
  toolNodesMap: {},
  workflowStartNodeId: undefined,
  hasToolNode: false,
  hasLoopRunNode: false
};

/**
 * 从 Runtime 结构快照单遍派生结构索引。
 * 语义版本不变时快照身份稳定，调用方按快照身份缓存即可跳过重算：
 * 本地交互（拖拽帧、选中、测量）只改画布数组，不会走到这里。
 * 工具节点判定与旧实现一致：被 selectedTools 出边指向且仍在文档中的节点。
 * 导出供单测直接校验派生语义。
 */
export const deriveStructureIndexes = (workflow?: WorkflowSnapshot): StructureIndexes => {
  if (!workflow) return EMPTY_STRUCTURE_INDEXES;

  const nodeIds: string[] = [];
  const childrenNodeIdListMap: Record<string, string[]> = {};
  const toolNodesMap: Record<string, boolean> = {};
  let workflowStartNodeId: string | undefined = undefined;
  let hasToolNode = false;
  let hasLoopRunNode = false;

  workflow.nodes.forEach((node) => {
    nodeIds.push(node.nodeId);
    if (node.parentNodeId) {
      const siblings = childrenNodeIdListMap[node.parentNodeId];
      if (siblings) siblings.push(node.nodeId);
      else childrenNodeIdListMap[node.parentNodeId] = [node.nodeId];
    }

    if (node.flowNodeType === FlowNodeTypeEnum.workflowStart) workflowStartNodeId = node.nodeId;
    if (node.flowNodeType === FlowNodeTypeEnum.toolCall) hasToolNode = true;
    if (node.flowNodeType === FlowNodeTypeEnum.loopRun) hasLoopRunNode = true;
  });

  const nodeIdSet = new Set(nodeIds);
  workflow.edges.forEach((edge) => {
    if (edge.targetHandle === NodeOutputKeyEnum.selectedTools && nodeIdSet.has(edge.target)) {
      toolNodesMap[edge.target] = true;
    }
  });

  return {
    nodeIds,
    nodeAmount: nodeIds.length,
    childrenNodeIdListMap,
    toolNodesMap,
    workflowStartNodeId,
    hasToolNode,
    hasLoopRunNode
  };
};

type FoldIndexes = {
  foldedNodesMap: Record<string, boolean>;
  allNodeFolded: boolean;
};

const EMPTY_FOLD_INDEXES: FoldIndexes = { foldedNodesMap: {}, allNodeFolded: true };

/**
 * 折叠索引只读 Node View：isFolded 不在语义快照里，纯几何事务也不 bump 语义版本，
 * 因此调用方必须把 runtime 事件计数一并作为缓存 key，否则折叠后索引不刷新。
 * comment 节点不参与「全部折叠」判定，空文档沿用 allNodeFolded = true，与旧实现一致。
 * 导出供单测直接校验派生语义。
 */
export const deriveFoldIndexes = (
  workflow: WorkflowSnapshot | undefined,
  runtime: WorkflowRuntimePort | null
): FoldIndexes => {
  if (!workflow || !runtime) return EMPTY_FOLD_INDEXES;

  const foldedNodesMap: Record<string, boolean> = {};
  let allNodeFolded = true;
  workflow.nodes.forEach((node) => {
    if (runtime.getNodeView(node.nodeId)?.isFolded) foldedNodesMap[node.nodeId] = true;
    else if (node.flowNodeType !== FlowNodeTypeEnum.comment) allNodeFolded = false;
  });
  return { foldedNodesMap, allNodeFolded };
};

type NodeDataIndexes = {
  nodeList: FlowNodeItemType[];
  nodesMap: Record<string, FlowNodeItemType>;
};

const EMPTY_NODE_DATA_INDEXES: NodeDataIndexes = { nodeList: [], nodesMap: {} };

/**
 * 从投影结果收集按 id 的节点数据：与画布节点共享同一份 data 对象身份，
 * 所以只能在重投影时更新，不能另行物化（会出现第二份 data，还要重复付模板展开开销）。
 */
const collectNodeDataIndexes = (nodes: CanvasNode[]): NodeDataIndexes => {
  const nodeList: FlowNodeItemType[] = [];
  const nodesMap: Record<string, FlowNodeItemType> = {};
  nodes.forEach((node) => {
    nodeList.push(node.data);
    nodesMap[node.data.nodeId] = node.data;
  });
  return { nodeList, nodesMap };
};

const WorkflowInitContextProvider = ({
  children,
  basicNodeTemplates
}: {
  children: ReactNode;
  basicNodeTemplates: FlowNodeTemplateType[];
}) => {
  const { t } = useTranslation();
  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);
  const runtimeTick = useContextSelector(WorkflowHostContext, (v) => v.runtimeTick);
  const overlaysRef = useContextSelector(WorkflowHostContext, (v) => v.overlaysRef);
  const patchViewData = useContextSelector(WorkflowHostContext, (v) => v.patchViewData);
  // 问题状态归 host：投影时合并问题文案与标红焦点，画布数组不再是问题状态的写入方。
  const issuesRef = useContextSelector(WorkflowHostContext, (v) => v.issuesRef);
  const issueFocusRef = useContextSelector(WorkflowHostContext, (v) => v.issueFocusRef);

  // 交互状态层：reactflow 本地数组，语义值以 Runtime 投影为准。
  const [nodes, setNodesRaw] = useState<CanvasNode[]>([]);
  const [edges, setEdgesRaw] = useState<Edge<any>[]>([]);
  // 按 id 的节点数据索引：只能在重投影时更新，与画布节点共享同一份 data 对象身份。
  const [nodeDataIndexes, setNodeDataIndexes] = useState<NodeDataIndexes>(EMPTY_NODE_DATA_INDEXES);
  // ref 与本地数组同步更新，保证同一 tick 内连续写入（先删节点再删边等）读到最新值。
  const nodesRef = useRef<CanvasNode[]>(nodes);
  const edgesRef = useRef<Edge<any>[]>(edges);
  const projectionCache = useRef(createProjectionCache());

  const isRuntimeActive = () => !!runtime && !runtime.isDisposed();

  /** 从 Runtime 全量重投影（含 overlay 与交互状态合并）；命令被拒时也用它回滚乐观写入。 */
  const syncFromRuntime = useMemoizedFn(() => {
    if (!isRuntimeActive()) return;
    const projected = projectRuntimeCanvas({
      runtime: runtime!,
      overlays: overlaysRef.current,
      issues: issuesRef.current,
      errorNodeId: issueFocusRef.current,
      t,
      localNodes: nodesRef.current,
      localEdges: edgesRef.current,
      cache: projectionCache.current
    });
    nodesRef.current = projected.nodes;
    edgesRef.current = projected.edges;
    setNodesRaw(projected.nodes);
    setEdgesRaw(projected.edges);
    setNodeDataIndexes(collectNodeDataIndexes(projected.nodes));
  });

  // 语言切换会让模板物化结果失效，投影缓存按节点 key 无法感知 t，直接整体作废。
  useEffect(() => {
    projectionCache.current = createProjectionCache();
  }, [t]);

  // Runtime 事件 / overlay 写入 -> 重投影。
  useEffect(() => {
    syncFromRuntime();
  }, [syncFromRuntime, runtime, runtimeTick]);

  const dispatchCommands = useMemoizedFn((commands: WorkflowCommand[]) => {
    if (commands.length === 0 || !isRuntimeActive()) return;
    const res = runtime!.dispatch(commands);
    if (!res.ok) {
      console.warn('[workflow-runtime-cutover] command rejected:', res.error);
      // 事务失败不产生事件，主动回滚乐观写入，保证画布与文档一致。
      syncFromRuntime();
    }
  });

  const setNodes = useMemoizedFn((action: SetStateAction<CanvasNode[]>) => {
    const prev = nodesRef.current;
    const next = typeof action === 'function' ? action(prev) : action;
    if (next === prev) return;
    nodesRef.current = next;
    setNodesRaw(next);
    if (!isRuntimeActive()) return;

    const { commands, viewPatches } = diffCanvasNodes({ prev, next });
    patchViewData(viewPatches);
    dispatchCommands(commands);
  });

  const setEdges = useMemoizedFn((action: SetStateAction<Edge<any>[]>) => {
    const prev = edgesRef.current;
    const next = typeof action === 'function' ? action(prev) : action;
    if (next === prev) return;
    edgesRef.current = next;
    setEdgesRaw(next);
    if (!isRuntimeActive()) return;

    dispatchCommands(diffCanvasEdges({ prev, next, runtimeEdges: runtime!.getWorkflow().edges }));
  });

  const onNodesChange = useMemoizedFn((changes: NodeChange[]) => {
    const prev = nodesRef.current;

    // Runtime 删除节点会级联删除后代；本地同步补全 remove 变更，避免重投影前残留一帧。
    let effectiveChanges = changes;
    const removeIds = changes
      .filter((change) => change.type === 'remove')
      .map((change) => change.id);
    if (removeIds.length > 0) {
      const removed = new Set(removeIds);
      let grew = true;
      while (grew) {
        grew = false;
        prev.forEach((node) => {
          const parentId = node.data.parentNodeId;
          if (parentId && removed.has(parentId) && !removed.has(node.id)) {
            removed.add(node.id);
            grew = true;
          }
        });
      }
      if (removed.size > removeIds.length) {
        const extra = [...removed]
          .filter((id) => !removeIds.includes(id))
          .map((id) => ({ type: 'remove' as const, id }));
        effectiveChanges = changes.concat(extra);
      }
    }

    const next = applyNodeChanges(effectiveChanges, prev);
    if (next !== prev) {
      nodesRef.current = next;
      setNodesRaw(next);
    }
    if (!isRuntimeActive()) return;

    // 拖拽帧只留在本地；手势结束（dragging:false）后批量提交几何。
    dispatchCommands([
      ...translateNodeRemoveChanges(effectiveChanges),
      ...translateDragEndChanges({
        changes,
        getPosition: (nodeId) => nodesRef.current.find((node) => node.id === nodeId)?.position
      })
    ]);
  });

  const onEdgesChange = useMemoizedFn((changes: EdgeChange[]) => {
    const prev = edgesRef.current;
    const next = applyEdgeChanges(changes, prev);
    if (next !== prev) {
      edgesRef.current = next;
      setEdgesRaw(next);
    }
    if (!isRuntimeActive()) return;

    const removeIds = changes
      .filter((change) => change.type === 'remove')
      .map((change) => change.id);
    if (removeIds.length === 0) return;
    dispatchCommands(
      translateEdgeRemoveChanges({
        ids: removeIds,
        localEdges: prev,
        runtimeEdges: runtime!.getWorkflow().edges
      })
    );
  });

  const getNodes = useMemoizedFn(() => nodesRef.current);

  // 文档结构快照：Runtime 语义版本不变时身份稳定（getWorkflow 有版本缓存），作为结构派生的缓存 key。
  const workflowSnapshot = isRuntimeActive() ? runtime!.getWorkflow() : undefined;
  // ponytail: 缓存粒度是语义版本，纯字段编辑也会重算一遍 O(n) 结构索引（输出身份仍由
  // useMemoEnhance 稳住，消费者不会多渲染）。要精确到「结构真变」需 adapter 暴露 null-safe
  // 的结构 handle：薄壳在 runtime hydrate 前就要渲染，直接用 useWorkflow() 会抛错。
  const structureIndexes = useMemo(
    () => deriveStructureIndexes(workflowSnapshot),
    [workflowSnapshot]
  );
  // 小体积索引用 useMemoEnhance 稳定身份：语义编辑没改结构时，消费者不必重渲染。
  const nodeIds = useMemoEnhance(() => structureIndexes.nodeIds, [structureIndexes.nodeIds]);
  const childrenNodeIdListMap = useMemoEnhance(
    () => structureIndexes.childrenNodeIdListMap,
    [structureIndexes.childrenNodeIdListMap]
  );
  const toolNodesMap = useMemoEnhance(
    () => structureIndexes.toolNodesMap,
    [structureIndexes.toolNodesMap]
  );
  const { nodeAmount, hasToolNode, hasLoopRunNode, workflowStartNodeId } = structureIndexes;

  const foldIndexes = useMemo(
    () => deriveFoldIndexes(workflowSnapshot, runtime),
    // runtimeTick 是刻意的缓存 key：折叠只写 Node View，纯几何事务不 bump 语义版本。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workflowSnapshot, runtime, runtimeTick]
  );
  const foldedNodesMap = useMemoEnhance(
    () => foldIndexes.foldedNodesMap,
    [foldIndexes.foldedNodesMap]
  );
  const allNodeFolded = foldIndexes.allNodeFolded;

  const { nodeList, nodesMap } = nodeDataIndexes;
  const workflowStartNode = workflowStartNodeId ? nodesMap[workflowStartNodeId] : undefined;

  const getNodeList = useMemoizedFn(() => nodeList);

  const getNodeById = useCallback(
    (nodeId: string | null | undefined, condition?: (node: FlowNodeItemType) => boolean) => {
      if (!nodeId) return undefined;
      const node = nodesMap[nodeId];
      if (!node) return undefined;
      return condition ? (condition(node) ? node : undefined) : node;
    },
    [nodesMap]
  );

  const rawNodesMap = useMemo(() => {
    const map: Record<string, CanvasNode> = {};
    nodes.forEach((node) => {
      map[node.id] = node;
    });
    return map;
  }, [nodes]);
  const getRawNodeById = useMemoizedFn((nodeId: string | null | undefined) => {
    return nodeId ? rawNodesMap[nodeId] : undefined;
  });

  // Snapshot blocking flag（旧快照机制的兼容占位；历史已由 Runtime 承担）
  const forbiddenSaveSnapshot = useRef(false);

  const rawNodeContextValue = useMemo(
    () => ({
      nodes,
      rawNodesMap,
      getRawNodeById
    }),
    [nodes, rawNodesMap, getRawNodeById]
  );

  const workflowBufferDataContextValue = useMemoEnhance(
    () => ({
      nodeIds,
      basicNodeTemplates,
      workflowStartNode,
      allNodeFolded,
      hasToolNode,
      hasLoopRunNode,
      toolNodesMap,
      foldedNodesMap,
      getNodeById,
      setNodes,
      onNodesChange,
      getNodes,
      getNodeList,
      edges,
      setEdges,
      onEdgesChange,
      forbiddenSaveSnapshot,
      nodeAmount,
      childrenNodeIdListMap
    }),
    [
      nodeIds,
      basicNodeTemplates,
      workflowStartNode,
      allNodeFolded,
      hasToolNode,
      hasLoopRunNode,
      toolNodesMap,
      foldedNodesMap,
      getNodeById,
      setNodes,
      onNodesChange,
      getNodes,
      getNodeList,
      edges,
      setEdges,
      onEdgesChange,
      nodeAmount,
      childrenNodeIdListMap
    ]
  );

  return (
    <WorkflowInitContext.Provider value={rawNodeContextValue}>
      <WorkflowBufferDataContext.Provider value={workflowBufferDataContextValue}>
        {children}
      </WorkflowBufferDataContext.Provider>
    </WorkflowInitContext.Provider>
  );
};

export default WorkflowInitContextProvider;
