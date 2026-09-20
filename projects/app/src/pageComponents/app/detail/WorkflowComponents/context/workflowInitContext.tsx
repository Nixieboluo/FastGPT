// [workflow-runtime-cutover] 临时兼容桥：本 Context 从数据源退化为投影 + 翻译层。
// Runtime 拥有唯一的 Workflow Document / Node View；这里只保留 reactflow 交互状态
// （选中、拖拽帧、测量尺寸、层级），把旧调用点的 setNodes/setEdges/onNodesChange/
// onEdgesChange 翻译成 Runtime 命令。迁移结束后薄壳随调用点改造删除。
import type {
  FlowNodeItemType,
  FlowNodeTemplateType
} from '@fastgpt/global/core/workflow/type/node';
import { createContext, useContextSelector } from 'use-context-selector';

import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import type { WorkflowCommand } from '@fastgpt/global/core/workflow/editor/types';
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

export type WorkflowNodeDataType = {
  selectedNodesMap: Record<string, boolean>;
};
export const WorkflowNodeDataContext = createContext<WorkflowNodeDataType>({
  selectedNodesMap: {}
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

  // 交互状态层：reactflow 本地数组，语义值以 Runtime 投影为准。
  const [nodes, setNodesRaw] = useState<CanvasNode[]>([]);
  const [edges, setEdgesRaw] = useState<Edge<any>[]>([]);
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
      t,
      localNodes: nodesRef.current,
      localEdges: edgesRef.current,
      cache: projectionCache.current
    });
    nodesRef.current = projected.nodes;
    edgesRef.current = projected.edges;
    setNodesRaw(projected.nodes);
    setEdgesRaw(projected.edges);
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

  const nodeFormat = useMemo(() => {
    const nodeIds: string[] = [];
    const nodeList: FlowNodeItemType[] = [];
    const nodesMap: Record<string, FlowNodeItemType> = {};
    const childrenNodeIdListMap: Record<string, string[]> = {};
    const selectedNodesMap: Record<string, boolean> = {};
    const foldedNodesMap: Record<string, boolean> = {};
    let workflowStartNode: FlowNodeItemType | undefined = undefined;
    let allNodeFolded = true;
    let hasToolNode = false;
    let hasLoopRunNode = false;

    nodes.forEach((node) => {
      const flowNodeType = node.data.flowNodeType;

      nodeIds.push(node.data.nodeId);
      nodeList.push(node.data);
      nodesMap[node.data.nodeId] = node.data;

      if (node.data.parentNodeId) {
        childrenNodeIdListMap[node.data.parentNodeId] = [
          ...(childrenNodeIdListMap[node.data.parentNodeId] || []),
          node.data.nodeId
        ];
      }

      if (node.selected) {
        selectedNodesMap[node.data.nodeId] = true;
      }
      if (node.data.isFolded) {
        foldedNodesMap[node.data.nodeId] = true;
      }

      if (flowNodeType === FlowNodeTypeEnum.workflowStart) {
        workflowStartNode = node.data;
      }
      if (!node.data.isFolded && flowNodeType !== FlowNodeTypeEnum.comment) {
        allNodeFolded = false;
      }

      if (flowNodeType === FlowNodeTypeEnum.toolCall) {
        hasToolNode = true;
      }
      if (flowNodeType === FlowNodeTypeEnum.loopRun) {
        hasLoopRunNode = true;
      }
    });

    return {
      nodeIds,
      nodeList,
      nodesMap,
      childrenNodeIdListMap,
      selectedNodesMap,
      workflowStartNode,
      allNodeFolded,
      hasToolNode,
      hasLoopRunNode,
      foldedNodesMap
    };
  }, [nodes]);

  // 拆解出常用的数据，避免重复计算
  const nodeIds = useMemoEnhance(() => nodeFormat.nodeIds, [nodeFormat.nodeIds]);
  const nodeList = useMemoEnhance(() => nodeFormat.nodeList, [nodeFormat.nodeList]);
  const nodesMap = useMemoEnhance(() => nodeFormat.nodesMap, [nodeFormat.nodesMap]);
  const selectedNodesMap = useMemoEnhance(
    () => nodeFormat.selectedNodesMap,
    [nodeFormat.selectedNodesMap]
  );
  const childrenNodeIdListMap = useMemoEnhance(
    () => nodeFormat.childrenNodeIdListMap,
    [nodeFormat.childrenNodeIdListMap]
  );
  const workflowStartNode = useMemoEnhance(
    () => nodeFormat.workflowStartNode,
    [nodeFormat.workflowStartNode]
  );
  const foldedNodesMap = useMemoEnhance(
    () => nodeFormat.foldedNodesMap,
    [nodeFormat.foldedNodesMap]
  );
  const allNodeFolded = nodeFormat.allNodeFolded;
  const hasToolNode = nodeFormat.hasToolNode;
  const hasLoopRunNode = nodeFormat.hasLoopRunNode;

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

  const toolNodesMap = useMemoEnhance(() => {
    const selectedToolEdgeMap: Record<string, boolean> = {};
    edges.forEach((edge) => {
      if (edge.targetHandle === NodeOutputKeyEnum.selectedTools) {
        selectedToolEdgeMap[edge.target] = true;
      }
    });

    return nodeList.reduce(
      (acc, node) => {
        if (selectedToolEdgeMap[node.nodeId]) {
          acc[node.nodeId] = true;
        }
        return acc;
      },
      {} as Record<string, boolean>
    );
  }, [nodeList, edges]);

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

  const nodeDataContextValue = useMemoEnhance(
    () => ({
      selectedNodesMap
    }),
    [selectedNodesMap]
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
      nodeAmount: nodeList.length,
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
      nodeList.length,
      childrenNodeIdListMap
    ]
  );

  return (
    <WorkflowInitContext.Provider value={rawNodeContextValue}>
      <WorkflowNodeDataContext.Provider value={nodeDataContextValue}>
        <WorkflowBufferDataContext.Provider value={workflowBufferDataContextValue}>
          {children}
        </WorkflowBufferDataContext.Provider>
      </WorkflowNodeDataContext.Provider>
    </WorkflowInitContext.Provider>
  );
};

export default WorkflowInitContextProvider;
