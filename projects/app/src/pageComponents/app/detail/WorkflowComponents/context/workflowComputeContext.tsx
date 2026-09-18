// 复杂计算上下文

import React, { useCallback, useMemo } from 'react';
import { createContext } from 'use-context-selector';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import type { Node } from 'reactflow';
import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';

// 创建 Context
type WorkflowComputeContextValue = {
  /** 重置父节点大小和位置 */
  resetParentNodeSizeAndPosition: (parentId: string) => void;

  /** 获取父节点大小和位置 */
  getParentNodeSizeAndPosition: (params: { nodes: Node<FlowNodeItemType>[]; parentId: string }) =>
    | {
        parentX: number;
        parentY: number;
        childWidth: number;
        childHeight: number;
        nodeWidth: number;
        nodeHeight: number;
      }
    | undefined;
};

export const WorkflowLayoutContext = createContext<WorkflowComputeContextValue>({
  resetParentNodeSizeAndPosition: function (parentId: string): void {
    throw new Error('Function not implemented.');
  },
  getParentNodeSizeAndPosition: function (params: {
    nodes: Node<FlowNodeItemType>[];
    parentId: string;
  }):
    | {
        parentX: number;
        parentY: number;
        childWidth: number;
        childHeight: number;
        nodeWidth: number;
        nodeHeight: number;
      }
    | undefined {
    throw new Error('Function not implemented.');
  }
});

export const WorkflowComputeProvider = ({ children }: { children: React.ReactNode }) => {
  /**
   * 获取父节点(Loop节点)的大小和位置
   * 基于子节点的位置计算父节点应该的位置和大小
   */
  const getParentNodeSizeAndPosition = useCallback(
    ({
      nodes,
      parentId
    }: Parameters<WorkflowComputeContextValue['getParentNodeSizeAndPosition']>[0]) => {
      const { childNodes, loopNode } = nodes.reduce(
        (acc, node) => {
          if (node.data.parentNodeId === parentId) {
            acc.childNodes.push(node);
          }
          if (node.id === parentId) {
            acc.loopNode = node;
          }
          return acc;
        },
        { childNodes: [] as Node[], loopNode: undefined as Node<FlowNodeItemType> | undefined }
      );

      if (!loopNode) return;
      if (childNodes.length === 0) return;
      // 任一子节点尚未被 ReactFlow 测量(width/height 未定义),直接放弃本次计算,
      // 由上游的 dimensionsSignal 监听在尺寸到齐后再触发一次。
      if (childNodes.some((n) => !n.width || !n.height)) return;
      const loopChilWidth =
        loopNode.data.inputs.find((node) => node.key === NodeInputKeyEnum.nodeWidth)?.value ?? 0;
      const loopChilHeight =
        loopNode.data.inputs.find((node) => node.key === NodeInputKeyEnum.nodeHeight)?.value ?? 0;

      // 初始化为第一个节点的边界
      let minX = childNodes[0].position.x;
      let minY = childNodes[0].position.y;
      let maxX = childNodes[0].position.x + (childNodes[0].width || 0);
      let maxY = childNodes[0].position.y + (childNodes[0].height || 0);

      // 遍历所有节点找出最小/最大边界
      childNodes.forEach((node) => {
        const nodeWidth = node.width || 0;
        const nodeHeight = node.height || 0;

        minX = Math.min(minX, node.position.x);
        minY = Math.min(minY, node.position.y);
        maxX = Math.max(maxX, node.position.x + nodeWidth);
        maxY = Math.max(maxY, node.position.y + nodeHeight);
      });

      const childWidth = Math.max(maxX - minX + 80, 0);
      const childHeight = Math.max(maxY - minY + 80, 0);

      const diffWidth = childWidth - loopChilWidth;
      const diffHeight = childHeight - loopChilHeight;
      const targetNodeWidth = (loopNode.width ?? 0) + diffWidth;
      const targetNodeHeight = (loopNode.height ?? 0) + diffHeight;

      const offsetHeight =
        loopNode.data.inputs.find((input) => input.key === NodeInputKeyEnum.nestedNodeInputHeight)
          ?.value ?? 83;

      return {
        parentX: Math.round(minX - 70),
        parentY: Math.round(minY - offsetHeight - 240),
        childWidth,
        childHeight,
        nodeWidth: targetNodeWidth,
        nodeHeight: targetNodeHeight
      };
    },
    []
  );

  /**
   * [workflow-runtime-cutover] 已接受的过渡期回归：容器尺寸字段（nodeWidth/nodeHeight/
   * nestedNodeInputHeight）在 migration 边界被清理，Runtime 不再存储它们，
   * 渲染副作用也不再写回文档（决策 9/10）。容器外框按兜底尺寸渲染，
   * 修复属于容器尺寸测量重做，见延后项文档；这里保留空实现维持旧调用点形状。
   */
  const resetParentNodeSizeAndPosition = useCallback((_parentId: string) => {
    // no-op
  }, []);

  const contextValue = useMemo(() => {
    return {
      resetParentNodeSizeAndPosition,
      getParentNodeSizeAndPosition
    };
  }, [resetParentNodeSizeAndPosition, getParentNodeSizeAndPosition]);

  return (
    <WorkflowLayoutContext.Provider value={contextValue}>{children}</WorkflowLayoutContext.Provider>
  );
};
