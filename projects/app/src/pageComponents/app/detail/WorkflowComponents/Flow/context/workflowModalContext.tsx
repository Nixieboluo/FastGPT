// renderer 层：功能性弹窗状态（历史版本 / 运行预览 / 添加节点 Popover）
import React, { useCallback, useState } from 'react';
import type { OnConnectStartParams } from 'reactflow';
import { createContext } from 'use-context-selector';
import ChatTest from '../ChatTest';
import type { StoreNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import type { StoreEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import { useChatStore } from '@/web/core/chat/context/useChatStore';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';

export type handleParamsType = OnConnectStartParams & {
  popoverPosition: { x: number; y: number };
  addNodePosition: { x: number; y: number };
};

export type WorkflowActivePanel = 'history' | 'run' | null;

type WorkflowTestData = {
  nodes: StoreNodeItemType[];
  edges: StoreEdgeItemType[];
};

type WorkflowModalContextValue = {
  /** 当前打开的右侧工作流弹窗，历史版本与运行预览通过单一状态互斥。 */
  activePanel: WorkflowActivePanel;

  /** 切换当前工作流弹窗。 */
  setActivePanel: React.Dispatch<React.SetStateAction<WorkflowActivePanel>>;

  /** 添加节点 Popover 参数。 */
  handleParams: handleParamsType | null;

  /** 设置添加节点 Popover 参数。 */
  setHandleParams: React.Dispatch<React.SetStateAction<handleParamsType | null>>;

  /** 写入运行预览数据并打开运行预览。 */
  setWorkflowTestData: React.Dispatch<React.SetStateAction<WorkflowTestData | undefined>>;
};

export const WorkflowModalContext = createContext<WorkflowModalContextValue>({
  activePanel: null,
  setActivePanel: function (_value: React.SetStateAction<WorkflowActivePanel>): void {
    throw new Error('Function not implemented.');
  },
  handleParams: null,
  setHandleParams: function (_value: React.SetStateAction<handleParamsType | null>): void {
    throw new Error('Function not implemented.');
  },
  setWorkflowTestData: function (_value: React.SetStateAction<WorkflowTestData | undefined>): void {
    throw new Error('Function not implemented.');
  }
});

/**
 * 弹窗状态 Provider：管理右侧面板互斥状态、添加节点 Popover 参数与运行预览数据，并渲染 ChatTest 面板。
 * Header 需要读写 activePanel，因此与 WorkflowUIProvider 一起挂在 Header 与画布的共同祖先上。
 */
export const WorkflowModalProvider = ({ children }: { children: React.ReactNode }) => {
  const [activePanel, setActivePanel] = useState<WorkflowActivePanel>(null);
  const [handleParams, setHandleParams] = useState<handleParamsType | null>(null);
  const [workflowTestData, setWorkflowTestDataState] = useState<WorkflowTestData>();
  const { chatId } = useChatStore();

  const setWorkflowTestData = useCallback<
    React.Dispatch<React.SetStateAction<WorkflowTestData | undefined>>
  >((value) => {
    setWorkflowTestDataState(value);
    setActivePanel('run');
  }, []);

  const contextValue = useMemoEnhance(
    () => ({
      activePanel,
      setActivePanel,
      handleParams,
      setHandleParams,
      setWorkflowTestData
    }),
    [activePanel, handleParams, setWorkflowTestData]
  );

  return (
    <WorkflowModalContext.Provider value={contextValue}>
      {children}
      <ChatTest
        isOpen={activePanel === 'run'}
        {...workflowTestData}
        onClose={() => setActivePanel(null)}
        chatId={chatId}
      />
    </WorkflowModalContext.Provider>
  );
};
