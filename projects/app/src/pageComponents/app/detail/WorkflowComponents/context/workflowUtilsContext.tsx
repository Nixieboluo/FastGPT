// [workflow-runtime-cutover] 临时兼容桥：只剩入站初始化与保存/发布 gate。
// initData 物化后创建/替换 Runtime；序列化入口与 Environment 定时扫描已迁入 host。
// 迁移结束后薄壳随调用点改造删除。
import React from 'react';
// 工作流工具函数层
import { useSystemStore } from '@/web/common/system/useSystemStore';
import { getWorkflowModelDetails } from '@/web/core/workflow/modelData';
import { materializeWorkflow } from '@/web/core/workflow/editor/codec';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import { checkWorkflowBeforeRunOrPublish } from '@/web/core/workflow/workflowCheck';
import { useUserStore } from '@/web/support/user/useUserStore';
import type { AppChatConfigType } from '@fastgpt/global/core/app/type';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import type { StoreEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import type { StoreNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import { useToast } from '@fastgpt/web/hooks/useToast';
import { useTranslation } from 'next-i18next';
import { type ReactNode, useCallback, useMemo } from 'react';
import { createContext, useContextSelector } from 'use-context-selector';
import { AppContext } from '../../context';
import { WorkflowBufferDataContext } from './workflowInitContext';

// 创建 Context
type WorkflowUtilsContextValue = {
  initData: (
    e: {
      nodes: StoreNodeItemType[];
      edges: StoreEdgeItemType[];
      chatConfig?: AppChatConfigType;
    },
    isInit?: boolean
  ) => Promise<void>;
  flowData2StoreData: () =>
    | {
        nodes: StoreNodeItemType[];
        edges: StoreEdgeItemType[];
      }
    | undefined;
  flowData2StoreDataAndCheck: (hideTip?: boolean) => Promise<
    | {
        nodes: StoreNodeItemType[];
        edges: StoreEdgeItemType[];
      }
    | undefined
  >;
};

export const WorkflowUtilsContext = createContext<WorkflowUtilsContextValue>({
  initData: (...args: Parameters<WorkflowUtilsContextValue['initData']>) => {
    void args;
    throw new Error('Function not implemented.');
  },
  flowData2StoreData: () => {
    throw new Error('Function not implemented.');
  },
  flowData2StoreDataAndCheck: (
    ...args: Parameters<WorkflowUtilsContextValue['flowData2StoreDataAndCheck']>
  ) => {
    void args;
    throw new Error('Function not implemented.');
  }
});

export const WorkflowUtilsProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { feConfigs } = useSystemStore();
  const { teamPlanStatus } = useUserStore();
  const showSandbox = feConfigs?.show_agent_sandbox;
  const enableSandbox = !teamPlanStatus?.standard || !!teamPlanStatus?.standard?.enableSandbox;

  const { appDetail, setAppDetail } = useContextSelector(AppContext, (v) => v);
  const { edges, getNodes } = useContextSelector(WorkflowBufferDataContext, (v) => v);
  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);
  const initRuntime = useContextSelector(WorkflowHostContext, (v) => v.initRuntime);
  const loadDocument = useContextSelector(WorkflowHostContext, (v) => v.loadDocument);
  /** 问题状态归 host：gate 校验结果写 host 问题存储，标红与定位由 host 焦点 API 承担。 */
  const syncIssues = useContextSelector(WorkflowHostContext, (v) => v.syncIssues);
  const clearIssues = useContextSelector(WorkflowHostContext, (v) => v.clearIssues);
  const focusIssueNode = useContextSelector(WorkflowHostContext, (v) => v.focusIssueNode);
  /** 出站序列化统一走 host：保存、发布、草稿、调试读同一份内容并共用保存点捕获。 */
  const flowData2StoreData = useContextSelector(WorkflowHostContext, (v) => v.serializeWorkflow);

  // 转换并验证工作流数据
  const flowData2StoreDataAndCheck = useCallback(
    async (hideTip = false) => {
      const nodes = getNodes();

      // Sandbox unavailable check
      const sandboxUnavailableNode = nodes.find((node) => {
        if (
          node.data.flowNodeType === FlowNodeTypeEnum.agent ||
          node.data.flowNodeType === FlowNodeTypeEnum.toolCall
        ) {
          const useAgentSandbox = node.data.inputs.find(
            (input) => input.key === NodeInputKeyEnum.useAgentSandbox
          )?.value;
          return !!useAgentSandbox && (!showSandbox || !enableSandbox);
        }
        return false;
      });

      if (sandboxUnavailableNode) {
        if (!hideTip) {
          focusIssueNode(sandboxUnavailableNode.data.nodeId);
          toast({
            status: 'warning',
            title: !showSandbox
              ? t('skill:sandbox_system_not_configured_toast')
              : t('app:sandbox_free_not_support')
          });
        }
        return;
      }

      const models = await getWorkflowModelDetails(nodes, appDetail.chatConfig).catch(
        () => undefined
      );
      if (!models) {
        if (!hideTip) toast({ status: 'error', title: t('common:model_catalog_load_failed') });
        return;
      }
      const { issueMap, hasError, firstErrorNodeId, chatConfigIssues } =
        checkWorkflowBeforeRunOrPublish({
          nodes,
          edges,
          models,
          chatConfig: appDetail.chatConfig,
          t
        });

      if (!hasError) {
        clearIssues();
        // Environment Issue 校验通过后，序列化与保存发布走同一个 codec。
        return flowData2StoreData();
      }

      if (!hideTip) {
        syncIssues(issueMap);
        if (firstErrorNodeId) focusIssueNode(firstErrorNodeId);

        toast({
          status: 'warning',
          title: t('common:core.workflow.Check Failed'),
          description: [...Object.values(issueMap).flat(), ...chatConfigIssues]
            .filter((issue) => issue.level === 'error')
            .map((issue) => issue.message)
            .filter(Boolean)
            .join('\n')
        });
      }
    },
    [
      getNodes,
      edges,
      t,
      showSandbox,
      enableSandbox,
      appDetail.chatConfig,
      toast,
      flowData2StoreData,
      syncIssues,
      clearIssues,
      focusIssueNode
    ]
  );

  /**
   * 初始化工作流数据：入站边界（migration + Template Materialization）后创建 Runtime。
   * isInit 且 Runtime 已存在说明是 tab 切换等重挂载，Runtime 就是当前状态，直接跳过；
   * 非 isInit（导入 JSON）走整文档替换，保留可撤销的历史。
   */
  const initData = useCallback(
    async (
      e: {
        nodes: StoreNodeItemType[];
        edges: StoreEdgeItemType[];
        chatConfig?: AppChatConfigType;
      },
      isInit?: boolean
    ) => {
      if (isInit && runtime && !runtime.isDisposed()) return;

      const content = materializeWorkflow({
        input: { nodes: e.nodes, edges: e.edges },
        chatConfig: e.chatConfig ?? appDetail.chatConfig,
        t
      });

      if (runtime && !runtime.isDisposed()) {
        loadDocument(content);
      } else {
        initRuntime(content);
      }
      setAppDetail((state) => ({ ...state, chatConfig: content.chatConfig }));
    },
    [appDetail.chatConfig, initRuntime, loadDocument, runtime, setAppDetail, t]
  );

  const contextValue = useMemo(() => {
    return {
      initData,
      flowData2StoreData,
      flowData2StoreDataAndCheck
    };
  }, [initData, flowData2StoreData, flowData2StoreDataAndCheck]);

  return (
    <WorkflowUtilsContext.Provider value={contextValue}>{children}</WorkflowUtilsContext.Provider>
  );
};
