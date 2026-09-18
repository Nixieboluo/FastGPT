// [workflow-runtime-cutover] 临时兼容桥：节点/边操作层。
// 旧 onChangeNode 各变体经 cutover/changeProps 翻译成 Runtime 命令；
// 错误标记、校验问题、调试结果等视图数据写进 host overlay，不再进节点数组。
// 迁移结束后薄壳随调用点改造删除。
// 工作流 Node/Edge 操作层
import { getWorkflowModelDetails } from '@/web/core/workflow/modelData';
import { checkWorkflowNodeIssues } from '@/web/core/workflow/workflowCheck';
import { collectWorkflowStartAutoFillRevertPatches } from '@/web/core/workflow/workflowStartAutoFill';
import type {
  FlowNodeTemplateType,
  WorkflowCheckIssue,
  WorkflowCheckNodeIssueMap
} from '@fastgpt/global/core/workflow/type/node';
import { useToast } from '@fastgpt/web/hooks/useToast';
import { useTranslation } from 'next-i18next';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnConnectStartParams } from 'reactflow';
import { createContext, useContextSelector } from 'use-context-selector';
import { useMemoizedFn } from 'ahooks';
import { WorkflowRuntimeHostContext } from '@/web/core/workflow/editor/cutover/runtimeHost';
import {
  buildDelEdgeCommands,
  buildResetNodeCommand,
  collectPostAttachDisconnects,
  translateChangeProps,
  type FlowNodeChangeProps
} from '@/web/core/workflow/editor/cutover/changeProps';
import type { ViewOverlayPatch } from '@/web/core/workflow/editor/cutover/translate';
import { WorkflowBufferDataContext } from './workflowInitContext';

// 创建 Context
type WorkflowActionsContextValue = {
  /** 更新节点错误状态 */
  onUpdateNodeError: (nodeId: string, isError: boolean) => void;

  /** 批量同步节点校验问题详情；不改动 isError */
  onSyncWorkflowCheckIssues: (nodeIssueMap: WorkflowCheckNodeIssueMap) => void;

  /** 单节点刷新校验问题详情，用于节点配置编辑后的局部复查 */
  onRefreshSingleNodeWorkflowCheckIssues: (nodeId: string) => void;

  /** 移除所有错误状态 */
  onRemoveError: () => void;

  /** 重置节点到模板状态 */
  onResetNode: (e: { id: string; node: FlowNodeTemplateType }) => void;

  /** 修改节点 */
  onChangeNode: (props: FlowNodeChangeProps | FlowNodeChangeProps[]) => void;

  /** 删除边 */
  onDelEdge: (e: { nodeId: string; sourceHandle?: string; targetHandle?: string }) => void;

  /** 连接中的边 */
  connectingEdge?: OnConnectStartParams;

  /** 设置连接中的边 */
  setConnectingEdge: React.Dispatch<React.SetStateAction<OnConnectStartParams | undefined>>;
};
export const WorkflowActionsContext = createContext<WorkflowActionsContextValue>({
  onUpdateNodeError: (...args: Parameters<WorkflowActionsContextValue['onUpdateNodeError']>) => {
    void args;
    throw new Error('Function not implemented.');
  },
  onSyncWorkflowCheckIssues: (
    ...args: Parameters<WorkflowActionsContextValue['onSyncWorkflowCheckIssues']>
  ) => {
    void args;
    throw new Error('Function not implemented.');
  },
  onRefreshSingleNodeWorkflowCheckIssues: (nodeId: string) => {
    void nodeId;
    throw new Error('Function not implemented.');
  },
  onRemoveError: () => {
    throw new Error('Function not implemented.');
  },
  onResetNode: (...args: Parameters<WorkflowActionsContextValue['onResetNode']>) => {
    void args;
    throw new Error('Function not implemented.');
  },
  onChangeNode: (...args: Parameters<WorkflowActionsContextValue['onChangeNode']>) => {
    void args;
    throw new Error('Function not implemented.');
  },
  onDelEdge: (...args: Parameters<WorkflowActionsContextValue['onDelEdge']>) => {
    void args;
    throw new Error('Function not implemented.');
  },
  setConnectingEdge: (...args: Parameters<WorkflowActionsContextValue['setConnectingEdge']>) => {
    void args;
    throw new Error('Function not implemented.');
  }
});

/** 边值相等（投影边 id 会随删除重排，比较必须按端点值）。 */
const edgeValueEqual = (
  a: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  b: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }
) =>
  a.source === b.source &&
  a.target === b.target &&
  (a.sourceHandle || '') === (b.sourceHandle || '') &&
  (a.targetHandle || '') === (b.targetHandle || '');

/**
 * WorkflowActionsProvider - 操作提供者
 */
export const WorkflowActionsProvider = ({ children }: { children: React.ReactNode }) => {
  const { t } = useTranslation();
  const { toast } = useToast();

  const runtime = useContextSelector(WorkflowRuntimeHostContext, (v) => v.runtime);
  const overlaysRef = useContextSelector(WorkflowRuntimeHostContext, (v) => v.overlaysRef);
  const patchViewData = useContextSelector(WorkflowRuntimeHostContext, (v) => v.patchViewData);

  // 获取 WorkflowBufferDataContext 的数据
  const {
    forbiddenSaveSnapshot: forbiddenSaveSnapshotRef,
    edges,
    getNodes,
    setNodes
  } = useContextSelector(WorkflowBufferDataContext, (v) => v);

  const singleNodeCheckTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const edgeCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstEdgesEffectRef = useRef(true);
  const prevEdgesRef = useRef(edges);

  // 连接状态
  const [connectingEdge, setConnectingEdge] = useState<OnConnectStartParams>();

  const isRuntimeActive = useMemoizedFn(() => !!runtime && !runtime.isDisposed());

  const writeIssueOverlay = useMemoizedFn(
    (nodeId: string, issues: WorkflowCheckIssue[] | undefined) => {
      const nextIssues = issues?.length ? issues : undefined;
      const current = overlaysRef.current[nodeId]?.workflowCheckIssues;
      if (JSON.stringify(current ?? undefined) === JSON.stringify(nextIssues)) return;
      const patch: ViewOverlayPatch = { nodeId, values: { workflowCheckIssues: nextIssues } };
      patchViewData([patch]);
    }
  );

  // 删除边：翻译成断连命令（按 handle 值匹配当前文档边）。
  const onDelEdge = useMemoizedFn(
    ({
      nodeId,
      sourceHandle,
      targetHandle
    }: {
      nodeId: string;
      sourceHandle?: string;
      targetHandle?: string;
    }) => {
      if (!sourceHandle && !targetHandle) return;
      if (!isRuntimeActive()) return;
      const commands = buildDelEdgeCommands({
        runtime: runtime!,
        nodeId,
        sourceHandle,
        targetHandle
      });
      if (commands.length === 0) return;
      const res = runtime!.dispatch(commands);
      if (!res.ok) console.warn('[workflow-runtime-cutover] onDelEdge rejected:', res.error);
    }
  );

  // 更新节点错误状态；标红时仅保留一个节点的 isError（旧行为），选中态属于交互层写本地。
  const onUpdateNodeError = useMemoizedFn((nodeId: string, isError: boolean) => {
    if (!isError) {
      patchViewData([{ nodeId, values: { isError: false } }]);
      return;
    }
    const patches: ViewOverlayPatch[] = [{ nodeId, values: { isError: true } }];
    Object.entries(overlaysRef.current).forEach(([id, values]) => {
      if (id !== nodeId && values?.isError)
        patches.push({ nodeId: id, values: { isError: false } });
    });
    patchViewData(patches);
    setNodes((state) =>
      state.map((item) => (item.data?.nodeId === nodeId ? { ...item, selected: true } : item))
    );
  });

  /** 同步节点下方问题文案；不改动 isError，标红仅由 onUpdateNodeError 控制。 */
  const onSyncWorkflowCheckIssues = useMemoizedFn((nodeIssueMap: WorkflowCheckNodeIssueMap) => {
    const patches: ViewOverlayPatch[] = [];
    const nodeIds = new Set([
      ...Object.keys(nodeIssueMap),
      ...Object.keys(overlaysRef.current).filter(
        (id) => overlaysRef.current[id]?.workflowCheckIssues !== undefined
      )
    ]);
    nodeIds.forEach((nodeId) => {
      const nextIssues = nodeIssueMap[nodeId]?.length ? nodeIssueMap[nodeId] : undefined;
      const current = overlaysRef.current[nodeId]?.workflowCheckIssues;
      if (JSON.stringify(current ?? undefined) === JSON.stringify(nextIssues)) return;
      patches.push({ nodeId, values: { workflowCheckIssues: nextIssues } });
    });
    patchViewData(patches);
  });

  /** 单节点配置变更后防抖重校验，仅同步问题文案，不自动标红。 */
  const onRefreshSingleNodeWorkflowCheckIssues = useMemoizedFn(async (nodeId: string) => {
    const nodes = getNodes();
    const models = await getWorkflowModelDetails(nodes.filter((node) => node.id === nodeId)).catch(
      () => undefined
    );
    if (
      !models ||
      getNodes().find((node) => node.id === nodeId)?.data.inputs !==
        nodes.find((node) => node.id === nodeId)?.data.inputs
    )
      return;
    const issueMap = checkWorkflowNodeIssues({
      nodes,
      edges,
      models,
      nodeId,
      t
    });
    writeIssueOverlay(nodeId, issueMap[nodeId]);
  });

  /** 节点配置变更后防抖触发单节点重新校验，避免每次输入都同步扫描。 */
  const scheduleSingleNodeWorkflowCheck = useCallback(
    (nodeId: string) => {
      const existingTimer = singleNodeCheckTimerRef.current.get(nodeId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      singleNodeCheckTimerRef.current.set(
        nodeId,
        setTimeout(() => {
          singleNodeCheckTimerRef.current.delete(nodeId);
          onRefreshSingleNodeWorkflowCheckIssues(nodeId);
        }, 400)
      );
    },
    [onRefreshSingleNodeWorkflowCheckIssues]
  );

  /** 连线变更后防抖全量扫描，及时更新 no_upstream 等依赖连线的错误态。 */
  const scheduleWorkflowCheckOnEdgeChange = useCallback(() => {
    if (edgeCheckTimerRef.current) {
      clearTimeout(edgeCheckTimerRef.current);
    }

    edgeCheckTimerRef.current = setTimeout(async () => {
      edgeCheckTimerRef.current = null;
      const nodes = getNodes();
      if (nodes.length === 0) return;

      const models = await getWorkflowModelDetails(nodes).catch(() => undefined);
      if (
        !models ||
        nodes.some(
          (node) =>
            getNodes().find((current) => current.id === node.id)?.data.inputs !== node.data.inputs
        )
      )
        return;
      const issueMap = checkWorkflowNodeIssues({ nodes, edges, models, t });
      onSyncWorkflowCheckIssues(issueMap);
    }, 400);
  }, [edges, getNodes, onSyncWorkflowCheckIssues, t]);

  // 旧节点修改回调：翻译成 Runtime 命令；记录级变更在 host 侧改完整份数组后走 updateNode。
  const onChangeNode = useMemoizedFn((props: FlowNodeChangeProps | FlowNodeChangeProps[]) => {
    const updateData = Array.isArray(props) ? props : [props];
    const nodeIdsToRecheck = new Set(updateData.map((item) => item.nodeId));

    if (isRuntimeActive()) {
      const { commands, viewPatches, duplicateKeyNodeIds, attachRequests } = translateChangeProps({
        props: updateData,
        runtime: runtime!
      });
      if (duplicateKeyNodeIds.length > 0) {
        toast({
          status: 'warning',
          title: t('common:key_repetition')
        });
      }
      patchViewData(viewPatches);
      if (commands.length > 0) {
        const res = runtime!.dispatch(commands);
        if (!res.ok) {
          console.warn('[workflow-runtime-cutover] onChangeNode rejected:', res.error);
        } else if (attachRequests.length > 0) {
          // attach 会由 Runtime 清理非法边；旧行为是落入容器时删除该节点全部连线，
          // 因此 attach 提交后按最新快照补一轮断连（逐节点提交，避免下标互相失效）。
          attachRequests.forEach(({ nodeId }) => {
            runtime!.dispatch(collectPostAttachDisconnects({ runtime: runtime!, nodeId }));
          });
        }
      }
    }

    if (updateData.length > 1) {
      scheduleWorkflowCheckOnEdgeChange();
    } else {
      nodeIdsToRecheck.forEach((nodeId) => scheduleSingleNodeWorkflowCheck(nodeId));
    }
  });

  // 移除所有节点的错误状态（overlay 清理 + 取消对应节点选中）。
  const onRemoveError = useMemoizedFn(() => {
    const patches: ViewOverlayPatch[] = [];
    const affectedNodeIds = new Set<string>();
    Object.entries(overlaysRef.current).forEach(([nodeId, values]) => {
      if (
        !values?.isError &&
        !(values?.workflowCheckIssues as WorkflowCheckIssue[] | undefined)?.length
      )
        return;
      affectedNodeIds.add(nodeId);
      patches.push({ nodeId, values: { isError: false, workflowCheckIssues: undefined } });
    });
    patchViewData(patches);
    if (affectedNodeIds.size > 0) {
      setNodes((state) =>
        state.map((item) =>
          affectedNodeIds.has(item.data.nodeId) ? { ...item, selected: false } : item
        )
      );
    }
  });

  // 重置节点：整节点替换命令（保留位置与折叠，合并已配置的工具输入）。
  const onResetNode = useMemoizedFn(({ id, node }: { id: string; node: FlowNodeTemplateType }) => {
    // 确保重置时不阻塞快照保存
    forbiddenSaveSnapshotRef.current = false;
    if (!isRuntimeActive()) return;
    const command = buildResetNodeCommand({ runtime: runtime!, nodeId: id, template: node });
    if (!command) return;
    const res = runtime!.dispatch([command]);
    if (!res.ok) console.warn('[workflow-runtime-cutover] onResetNode rejected:', res.error);
  });

  // 断连后回退工作流开始自动填充（Runtime 只在连线时自动填充，不回退，旧行为由桥保留）。
  // 投影边 id 会随删除整体重排，因此按端点值而不是 id 找被删的边。
  useEffect(() => {
    if (isFirstEdgesEffectRef.current) {
      isFirstEdgesEffectRef.current = false;
      prevEdgesRef.current = edges;
      return;
    }

    const prevEdges = prevEdgesRef.current;
    const removedEdges = prevEdges.filter(
      (prevEdge) => !edges.some((edge) => edgeValueEqual(edge, prevEdge))
    );
    prevEdgesRef.current = edges;

    if (removedEdges.length > 0 && isRuntimeActive()) {
      const getNodeDataById = (nodeId: string) =>
        getNodes().find((node) => node.data.nodeId === nodeId)?.data;

      const patches = collectWorkflowStartAutoFillRevertPatches({
        removedEdges,
        remainingEdges: edges,
        getNodeById: getNodeDataById
      });

      if (patches.length > 0) {
        const { commands } = translateChangeProps({
          props: patches.map((patch) => ({ ...patch, type: 'updateInput' as const })),
          runtime: runtime!
        });
        if (commands.length > 0) runtime!.dispatch(commands);
      }
    }

    scheduleWorkflowCheckOnEdgeChange();
  }, [edges, scheduleWorkflowCheckOnEdgeChange, getNodes, runtime, isRuntimeActive]);

  useEffect(() => {
    const timers = singleNodeCheckTimerRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      if (edgeCheckTimerRef.current) {
        clearTimeout(edgeCheckTimerRef.current);
      }
    };
  }, []);

  const contextValue = useMemo(() => {
    return {
      onUpdateNodeError,
      onSyncWorkflowCheckIssues,
      onRefreshSingleNodeWorkflowCheckIssues,
      onRemoveError,
      onResetNode,
      onChangeNode,
      onDelEdge,
      connectingEdge,
      setConnectingEdge
    };
  }, [
    onUpdateNodeError,
    onSyncWorkflowCheckIssues,
    onRefreshSingleNodeWorkflowCheckIssues,
    onRemoveError,
    onResetNode,
    onChangeNode,
    onDelEdge,
    connectingEdge
  ]);

  return (
    <WorkflowActionsContext.Provider value={contextValue}>
      {children}
    </WorkflowActionsContext.Provider>
  );
};
