// [workflow-runtime-cutover] 临时兼容桥：节点/边操作层。
// 旧 onChangeNode 各变体经 cutover/changeProps 翻译成 Runtime 命令；
// 调试结果等视图数据写进 host overlay，不再进节点数组。
// 问题状态（标红焦点、问题文案、单节点复查）归 host 问题存储，本层不再有 issue 回调。
// 迁移结束后薄壳随调用点改造删除。
// 工作流 Node/Edge 操作层
import { collectWorkflowStartAutoFillRevertPatches } from '@/web/core/workflow/workflowStartAutoFill';
import type { FlowNodeTemplateType } from '@fastgpt/global/core/workflow/type/node';
import { useToast } from '@fastgpt/web/hooks/useToast';
import { useTranslation } from 'next-i18next';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { OnConnectStartParams } from 'reactflow';
import { createContext, useContextSelector } from 'use-context-selector';
import { useMemoizedFn } from 'ahooks';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import {
  buildDelEdgeCommands,
  buildResetNodeCommand,
  collectPostAttachDisconnects,
  translateChangeProps,
  type FlowNodeChangeProps
} from '@/web/core/workflow/editor/cutover/changeProps';
import { WorkflowBufferDataContext } from './workflowInitContext';

// 创建 Context
type WorkflowActionsContextValue = {
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

  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);
  const patchViewData = useContextSelector(WorkflowHostContext, (v) => v.patchViewData);

  // 获取 WorkflowBufferDataContext 的数据
  const {
    forbiddenSaveSnapshot: forbiddenSaveSnapshotRef,
    edges,
    getNodes
  } = useContextSelector(WorkflowBufferDataContext, (v) => v);

  const isFirstEdgesEffectRef = useRef(true);
  const prevEdgesRef = useRef(edges);

  // 连接状态
  const [connectingEdge, setConnectingEdge] = useState<OnConnectStartParams>();

  const isRuntimeActive = useMemoizedFn(() => !!runtime && !runtime.isDisposed());

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

  /**
   * 旧节点修改回调：翻译成 Runtime 命令；记录级变更在 host 侧改完整份数组后走 updateNode。
   * 问题文案不在这里复查：写入后由 host 定时扫描统一刷新（模板新增节点走 host 的单节点复查）。
   */
  const onChangeNode = useMemoizedFn((props: FlowNodeChangeProps | FlowNodeChangeProps[]) => {
    const updateData = Array.isArray(props) ? props : [props];

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
  }, [edges, getNodes, runtime, isRuntimeActive]);

  const contextValue = useMemo(() => {
    return {
      onResetNode,
      onChangeNode,
      onDelEdge,
      connectingEdge,
      setConnectingEdge
    };
  }, [onResetNode, onChangeNode, onDelEdge, connectingEdge]);

  return (
    <WorkflowActionsContext.Provider value={contextValue}>
      {children}
    </WorkflowActionsContext.Provider>
  );
};
