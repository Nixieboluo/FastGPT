import type { FlowNodeTemplateType } from '@fastgpt/global/core/workflow/type/node';
import React from 'react';
import { ReactFlowProvider } from 'reactflow';
import { WorkflowHostProvider } from '@/web/core/workflow/editor/host';
import WorkflowInitContextProvider from './workflowInitContext';
import { WorkflowUtilsProvider } from './workflowUtilsContext';
import { WorkflowActionsProvider } from './workflowActionsContext';
import { WorkflowDebugProvider } from './workflowDebugContext';
import { WorkflowUIProvider } from './workflowUIContext';
import { WorkflowModalProvider } from './workflowModalContext';
import { WorkflowComputeProvider } from './workflowComputeContext';

/* 
  ReactFlowProvider
  └── WorkflowHostProvider             // Layer 0: host（Runtime 生命周期、adapter、版本、保存、问题、草稿）
      └── WorkflowInitContextProvider  // Layer 1: 基础数据
      └── WorkflowBufferDataContext    // Layer 2: 节点边数据
          └── WorkflowActionsProvider  // Layer 3: 节点边操作
              └── WorkflowUtilsProvider    // Layer 4: 纯函数工具
                  └── WorkflowDebugProvider    // Layer 5: 调试功能
                      └── WorkflowUIProvider       // Layer 6: UI 交互
                          └── WorkflowModalProvider    // Layer 7: 弹窗管理
                              └── WorkflowComputeProvider // Layer 8: 复杂计算
*/
export const ReactFlowCustomProvider = ({
  templates,
  children
}: {
  templates: FlowNodeTemplateType[];
  children: React.ReactNode;
}) => {
  return (
    <ReactFlowProvider>
      <WorkflowHostProvider>
        <WorkflowInitContextProvider basicNodeTemplates={templates}>
          <WorkflowActionsProvider>
            <WorkflowUtilsProvider>
              <WorkflowDebugProvider>
                <WorkflowUIProvider>
                  <WorkflowModalProvider>
                    <WorkflowComputeProvider>{children}</WorkflowComputeProvider>
                  </WorkflowModalProvider>
                </WorkflowUIProvider>
              </WorkflowDebugProvider>
            </WorkflowUtilsProvider>
          </WorkflowActionsProvider>
        </WorkflowInitContextProvider>
      </WorkflowHostProvider>
    </ReactFlowProvider>
  );
};
