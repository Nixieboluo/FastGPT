import type { Node } from 'reactflow';
import {
  Input_Template_NESTED_NODE_OFFSET,
  Input_Template_Node_Height,
  Input_Template_Node_Width
} from '@fastgpt/global/core/workflow/template/input';
import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';

export type ParentNodeLayout = {
  parentX: number;
  parentY: number;
  childWidth: number;
  childHeight: number;
  nodeWidth: number;
  nodeHeight: number;
};

// ponytail: 三个常量取自模板默认尺寸，与容器尺寸字段被剥离前的画布行为一致；测量重做后按真实尺寸计算。
const CONTAINER_WIDTH = Number(Input_Template_Node_Width.value ?? 0);
const CONTAINER_HEIGHT = Number(Input_Template_Node_Height.value ?? 0);
const CONTAINER_INPUT_HEIGHT = Number(Input_Template_NESTED_NODE_OFFSET.value ?? 83);

/**
 * 按子节点包围盒计算容器（Loop 系列）节点应有的位置与尺寸。
 *
 * 纯函数：只读传入的画布节点数组，不写文档、不依赖 Context，调用方自行决定如何使用结果。
 * 任一子节点还没被 ReactFlow 测量出 width/height 时返回 undefined，由调用方在尺寸到齐后重试。
 *
 * 注意：容器尺寸字段（nodeWidth/nodeHeight/nestedNodeInputHeight）目前不在 Runtime 文档里，
 * 渲染副作用也不回写（已接受的过渡回归），容器外框按兜底尺寸渲染；
 * 修复属于容器尺寸测量重做，见延后项文档。
 */
export const getParentNodeSizeAndPosition = ({
  nodes,
  parentId
}: {
  nodes: Node<FlowNodeItemType>[];
  parentId: string;
}): ParentNodeLayout | undefined => {
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
    {
      childNodes: [] as Node<FlowNodeItemType>[],
      loopNode: undefined as Node<FlowNodeItemType> | undefined
    }
  );

  if (!loopNode) return;
  if (childNodes.length === 0) return;
  // 任一子节点尚未被 ReactFlow 测量(width/height 未定义),直接放弃本次计算,
  // 由调用方在子节点尺寸到齐后再触发一次。
  if (childNodes.some((n) => !n.width || !n.height)) return;
  const loopChilWidth = CONTAINER_WIDTH;
  const loopChilHeight = CONTAINER_HEIGHT;

  // 初始化为第一个节点的边界
  let minX = childNodes[0].position.x;
  let minY = childNodes[0].position.y;
  let maxX = childNodes[0].position.x + (childNodes[0].width || 0);
  let maxY = childNodes[0].position.y + (childNodes[0].height || 0);

  // 遍历所有子节点找出最小/最大边界
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

  const offsetHeight = CONTAINER_INPUT_HEIGHT;

  return {
    parentX: Math.round(minX - 70),
    parentY: Math.round(minY - offsetHeight - 240),
    childWidth,
    childHeight,
    nodeWidth: targetNodeWidth,
    nodeHeight: targetNodeHeight
  };
};
