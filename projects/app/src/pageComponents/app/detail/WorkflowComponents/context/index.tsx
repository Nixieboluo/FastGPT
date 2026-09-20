import type { FlowNodeTemplateType } from '@fastgpt/global/core/workflow/type/node';
import React from 'react';
import { ReactFlowProvider } from 'reactflow';
import { WorkflowHostProvider } from '@/web/core/workflow/editor/host';
import WorkflowInitContextProvider from './workflowInitContext';
import { WorkflowUtilsProvider } from './workflowUtilsContext';
import { WorkflowActionsProvider } from './workflowActionsContext';
import { WorkflowDebugProvider } from './workflowDebugContext';

/* 
  ReactFlowProvider
  └── WorkflowHostProvider             // Layer 0: host（Runtime 生命周期、adapter、版本、保存、问题、草稿）
      └── WorkflowInitContextProvider  // Layer 1: 基础数据
      └── WorkflowBufferDataContext    // Layer 2: 节点边数据
          └── WorkflowActionsProvider  // Layer 3: 节点边操作
              └── WorkflowUtilsProvider    // Layer 4: 纯函数工具
                  └── WorkflowDebugProvider    // Layer 5: 调试功能

  UI 交互、选中态与弹窗 Context 属于 renderer 层（Flow/context/），挂载点在 renderer 组件树
  （页面 WorkflowEdit 与画布 Flow）。
*/

/**
 * 工作流编辑器的数据层装配：ReactFlow + host + 数据 Context 链。
 * 只负责数据与 host 生命周期，renderer 层的交互状态由页面组件树自行挂载。
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
              <WorkflowDebugProvider>{children}</WorkflowDebugProvider>
            </WorkflowUtilsProvider>
          </WorkflowActionsProvider>
        </WorkflowInitContextProvider>
      </WorkflowHostProvider>
    </ReactFlowProvider>
  );
};
