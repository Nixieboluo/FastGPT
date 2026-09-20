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
import {
  canInputBeAgentGenerated,
  normalizeFlowNodeInputType
} from '@fastgpt/global/core/app/formEdit/utils';
import type { AppChatConfigType } from '@fastgpt/global/core/app/type';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import {
  FlowNodeOutputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import type { StoreEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import type {
  FlowNodeInputItemType,
  FlowNodeOutputItemType
} from '@fastgpt/global/core/workflow/type/io';
import type { StoreNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import { useToast } from '@fastgpt/web/hooks/useToast';
import { useTranslation } from 'next-i18next';
import { type ReactNode, useCallback, useMemo } from 'react';
import { useReactFlow } from 'reactflow';
import { createContext, useContextSelector } from 'use-context-selector';
import { AppContext } from '../../context';
import { WorkflowActionsContext } from './workflowActionsContext';
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
  splitToolInputs: (
    inputs: FlowNodeInputItemType[],
    nodeId: string
  ) => {
    isTool: boolean;
    toolInputs: FlowNodeInputItemType[];
    commonInputs: FlowNodeInputItemType[];
  };
  splitOutput: (outputs: FlowNodeOutputItemType[]) => {
    successOutputs: FlowNodeOutputItemType[];
    hiddenOutputs: FlowNodeOutputItemType[];
    errorOutputs: FlowNodeOutputItemType[];
  };
};

/** 将工具输入和普通节点输入分开，避免 Agent 生成参数在节点内重复渲染。 */
export const splitToolInputsByMode = (inputs: FlowNodeInputItemType[], isTool: boolean) => {
  const toolInputs: FlowNodeInputItemType[] = [];
  const commonInputs: FlowNodeInputItemType[] = [];

  inputs.forEach((item) => {
    const normalizedInput = normalizeFlowNodeInputType(item, { isTool });
    // canEdit 仅表示该字段可在节点内编辑；代码变量不应自动成为工具参数。
    const isToolParamInput =
      item.canEdit === true &&
      item.defaultToAgentGenerated === true &&
      canInputBeAgentGenerated(item);

    if (isTool && isToolParamInput) {
      toolInputs.push(item);
      return;
    }

    commonInputs.push(normalizedInput);
  });

  return {
    toolInputs,
    commonInputs
  };
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
  },
  splitOutput: (...args: Parameters<WorkflowUtilsContextValue['splitOutput']>) => {
    void args;
    throw new Error('Function not implemented.');
  },
  splitToolInputs: (...args: Parameters<WorkflowUtilsContextValue['splitToolInputs']>) => {
    void args;
    throw new Error('Function not implemented.');
  }
});

export const WorkflowUtilsProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { fitView } = useReactFlow();
  const { feConfigs } = useSystemStore();
  const { teamPlanStatus } = useUserStore();
  const showSandbox = feConfigs?.show_agent_sandbox;
  const enableSandbox = !teamPlanStatus?.standard || !!teamPlanStatus?.standard?.enableSandbox;

  const { appDetail, setAppDetail } = useContextSelector(AppContext, (v) => v);
  const { edges, getNodes, toolNodesMap } = useContextSelector(WorkflowBufferDataContext, (v) => v);
  const { onRemoveError, onUpdateNodeError, onSyncWorkflowCheckIssues } = useContextSelector(
    WorkflowActionsContext,
    (v) => v
  );
  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);
  const initRuntime = useContextSelector(WorkflowHostContext, (v) => v.initRuntime);
  const loadDocument = useContextSelector(WorkflowHostContext, (v) => v.loadDocument);
  /** 出站序列化统一走 host：保存、发布、草稿、调试读同一份内容并共用保存点捕获。 */
  const flowData2StoreData = useContextSelector(WorkflowHostContext, (v) => v.serializeWorkflow);

  // 优化为单次遍历,分类输出项
  const splitOutput = useCallback((outputs: FlowNodeOutputItemType[]) => {
    const successOutputs: FlowNodeOutputItemType[] = [];
    const hiddenOutputs: FlowNodeOutputItemType[] = [];
    const errorOutputs: FlowNodeOutputItemType[] = [];

    outputs.forEach((item) => {
      if (
        item.type === FlowNodeOutputTypeEnum.dynamic ||
        item.type === FlowNodeOutputTypeEnum.static ||
        item.type === FlowNodeOutputTypeEnum.source
      ) {
        successOutputs.push(item);
      } else if (item.type === FlowNodeOutputTypeEnum.hidden) {
        hiddenOutputs.push(item);
      } else {
        errorOutputs.push(item);
      }
    });

    return {
      successOutputs,
      hiddenOutputs,
      errorOutputs
    };
  }, []);
  /* If the module is connected by a tool, the tool input and the normal input are separated */
  const splitToolInputs = useCallback(
    (inputs: FlowNodeInputItemType[], nodeId: string) => {
      const isTool = toolNodesMap[nodeId] ?? false;
      const { toolInputs, commonInputs } = splitToolInputsByMode(inputs, isTool);

      return {
        isTool,
        toolInputs,
        commonInputs
      };
    },
    [toolNodesMap]
  );

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
          onUpdateNodeError(sandboxUnavailableNode.data.nodeId, true);
          fitView({
            nodes: [sandboxUnavailableNode],
            padding: 0.3
          });
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
        onRemoveError();
        // Environment Issue 校验通过后，序列化与保存发布走同一个 codec。
        return flowData2StoreData();
      }

      if (!hideTip) {
        onSyncWorkflowCheckIssues(issueMap);

        if (firstErrorNodeId) {
          onUpdateNodeError(firstErrorNodeId, true);
          const firstErrorNode = nodes.find((node) => node.data.nodeId === firstErrorNodeId);
          if (firstErrorNode) {
            fitView({
              nodes: [firstErrorNode],
              padding: 0.3
            });
          }
        }

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
      onRemoveError,
      onSyncWorkflowCheckIssues,
      fitView,
      t,
      onUpdateNodeError,
      showSandbox,
      enableSandbox,
      appDetail.chatConfig,
      toast,
      flowData2StoreData
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
      flowData2StoreDataAndCheck,
      splitOutput,
      splitToolInputs
    };
  }, [initData, flowData2StoreData, flowData2StoreDataAndCheck, splitOutput, splitToolInputs]);

  return (
    <WorkflowUtilsContext.Provider value={contextValue}>{children}</WorkflowUtilsContext.Provider>
  );
};
