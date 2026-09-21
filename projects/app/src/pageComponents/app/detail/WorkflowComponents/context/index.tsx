import React from 'react';
import { ReactFlowProvider } from 'reactflow';
import { WorkflowHostProvider } from '@/web/core/workflow/editor/host';
import WorkflowCanvasProvider from '../Flow/context/workflowCanvasContext';
import { WorkflowDebugProvider } from './workflowDebugContext';

/* 
  ReactFlowProvider
  └── WorkflowHostProvider             // Runtime lifecycle, persistence and issue state
  └── WorkflowCanvasProvider       // renderer projection and interaction state
          └── WorkflowDebugProvider    // debug session renderer state

  UI 交互、选中态与弹窗 Context 属于 renderer 层（Flow/context/），挂载点在 renderer 组件树
  （页面 WorkflowEdit 与画布 Flow）。
*/

/**
 * 工作流编辑器装配：ReactFlow + host + renderer canvas state。
 */
export const ReactFlowCustomProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <ReactFlowProvider>
      <WorkflowHostProvider>
        <WorkflowCanvasProvider>
          <WorkflowDebugProvider>{children}</WorkflowDebugProvider>
        </WorkflowCanvasProvider>
      </WorkflowHostProvider>
    </ReactFlowProvider>
  );
};
