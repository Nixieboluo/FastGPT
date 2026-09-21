import { Box, HStack, type StackProps } from '@chakra-ui/react';
import React, { useCallback, useMemo } from 'react';
import MyIcon from '@fastgpt/web/components/common/Icon';
import { useTranslation } from 'next-i18next';
import { nodeTemplate2FlowNode } from '@/web/core/workflow/utils';
import { CommentNode } from '@fastgpt/global/core/workflow/template/system/comment';
import { useContextSelector } from 'use-context-selector';
import { type Node, useReactFlow } from 'reactflow';
import dagre from '@dagrejs/dagre';
import { type FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import { cloneDeep } from 'lodash-es';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import { WorkflowUIContext } from '../context/workflowUIContext';
import { getHandleIndex } from '../utils/edge';
import { getParentNodeSizeAndPosition } from '../utils/layout';
import { useCanvas, useWorkflow as useWorkflowAdapter } from '@/web/core/workflow/editor';
import { canvasNodeToStoreNode } from '@/web/core/workflow/editor/canvas';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import { useWorkflowDocument } from '../nodes/render/useWorkflowDocument';

/** 右键菜单单项：执行动作后关闭菜单。不依赖父组件状态，放模块级避免每次渲染重建组件。 */
const ContextMenuItem = ({
  icon,
  label,
  onClick,
  ...props
}: {
  icon: string;
  label: string;
  onClick: () => any;
} & StackProps) => {
  const setMenu = useContextSelector(WorkflowUIContext, (ctx) => ctx.setMenu);

  return (
    <HStack
      px={2}
      py={1}
      cursor={'pointer'}
      borderRadius={'sm'}
      _hover={{ bg: 'myGray.50', color: 'primary.500' }}
      onClick={() => {
        onClick();
        setMenu(null);
      }}
      {...props}
    >
      <MyIcon name={icon as any} w={'1rem'} ml={1} />
      <Box fontSize={'sm'} fontWeight={'500'}>
        {label}
      </Box>
    </HStack>
  );
};

const ContextMenu = () => {
  const { t } = useTranslation();
  const menu = useContextSelector(WorkflowUIContext, (v) => v.menu!);
  const workflow = useWorkflowAdapter();
  const canvas = useCanvas();

  // 自动对齐与折叠都只碰 renderer 交互状态（位置、测量尺寸），直接读写 reactflow store。
  const { fitView, screenToFlowPosition, getNodes, setNodes, getEdges } = useReactFlow();
  const { reader } = useWorkflowDocument();
  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);
  const runtimeTick = useContextSelector(WorkflowHostContext, (v) => v.runtimeTick);

  /**
   * 是否全部节点已折叠：折叠存在 Node View 上，语义快照不含，
   * 因此 runtimeTick 是刻意的缓存 key（纯几何事务不 bump 语义版本）。
   * comment 节点不参与判定，空文档视为已全部折叠，与旧派生索引一致。
   */
  const allNodeFolded = useMemo(() => {
    const nodes = reader?.nodes ?? [];
    return nodes.every(
      (node) =>
        node.flowNodeType === FlowNodeTypeEnum.comment ||
        !!runtime?.getNodeView(node.nodeId)?.isFolded
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, runtime, runtimeTick]);

  const onLayout = useCallback(() => {
    const updateChildNodesPosition = ({
      startNode,
      nodes,
      edges
    }: {
      startNode: Node<FlowNodeItemType>;
      nodes: Node<FlowNodeItemType>[];
      edges: any[];
    }) => {
      const startPosition = { x: startNode.position.x, y: startNode.position.y };

      const dagreGraph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
      dagreGraph.setGraph({
        rankdir: 'LR',
        nodesep: 80,
        ranksep: 200
      });

      nodes.forEach((node) => {
        dagreGraph.setNode(node.id, { width: node.width!, height: node.height! });
      });

      // Find connected nodes
      const connectedNodeIds = new Set<string>();
      edges.forEach((edge) => {
        connectedNodeIds.add(edge.source);
        connectedNodeIds.add(edge.target);

        dagreGraph.setEdge(edge.source, edge.target);
      });

      dagre.layout(dagreGraph);
      const layoutedStartNode = dagreGraph.node(startNode.data.nodeId);
      const offsetX = startPosition.x - (layoutedStartNode.x - startNode.width! / 2);
      const offsetY = startPosition.y - (layoutedStartNode.y - startNode.height! / 2);

      // Group nodes by rank (horizontal position in LR layout)
      const nodesByRank: Map<
        number,
        Array<{ node: Node<FlowNodeItemType>; dagreNode: any }>
      > = new Map();

      nodes.forEach((node) => {
        if (!connectedNodeIds.has(node.id)) {
          return;
        }

        const nodeWithPosition = dagreGraph.node(node.id);
        const rank = Math.round(nodeWithPosition.x); // Group by x coordinate (same column)

        if (!nodesByRank.has(rank)) {
          nodesByRank.set(rank, []);
        }
        nodesByRank.get(rank)!.push({ node, dagreNode: nodeWithPosition });
      });

      // Apply left-aligned positioning for nodes in same column (vertical stacking)
      const nodesMap = new Map(nodes.map((n) => [n.id, n]));
      nodesByRank.forEach((nodesInRank) => {
        // Find the minimum left position (for left alignment)
        let minLeft = Infinity;
        nodesInRank.forEach(({ node, dagreNode }) => {
          const left = dagreNode.x - node.width! / 2;
          minLeft = Math.min(minLeft, left);
        });

        // Sort nodes: use handle index for special nodes, otherwise maintain original Y position
        nodesInRank.sort((a, b) => {
          const edgeA = edges.find((e) => e.target === a.node.id);
          const edgeB = edges.find((e) => e.target === b.node.id);
          const sourceA = nodesMap.get(edgeA?.source);
          const sourceB = nodesMap.get(edgeB?.source);

          // Check if sources are special nodes (ifElse, userSelect, classifyQuestion)
          const specialNodeTypes = [
            FlowNodeTypeEnum.ifElseNode,
            FlowNodeTypeEnum.userSelect,
            FlowNodeTypeEnum.classifyQuestion
          ];
          const isSourceASpecial = sourceA && specialNodeTypes.includes(sourceA.data.flowNodeType);
          const isSourceBSpecial = sourceB && specialNodeTypes.includes(sourceB.data.flowNodeType);

          // If both from special nodes or both from regular nodes with same source, use handle index
          if (
            edgeA?.source === edgeB?.source &&
            (isSourceASpecial || isSourceBSpecial || !sourceA || !sourceB)
          ) {
            return getHandleIndex(edgeA, sourceA) - getHandleIndex(edgeB, sourceB);
          }

          // Otherwise, maintain original Y position order
          return a.dagreNode.y - b.dagreNode.y;
        });

        // Assign Y positions in sorted order
        let currentY =
          Math.min(...nodesInRank.map(({ dagreNode, node }) => dagreNode.y - node.height! / 2)) +
          offsetY;
        nodesInRank.forEach(({ node }) => {
          node.position = { x: minLeft + offsetX, y: currentY };
          currentY += node.height! + 80;
        });
      });
    };
    const updateParentNodesPosition = ({
      startNode,
      nodes,
      edges
    }: {
      startNode: Node<FlowNodeItemType>;
      nodes: Node<FlowNodeItemType>[];
      edges: any[];
    }) => {
      const startPosition = { x: startNode.position.x, y: startNode.position.y };

      const childNodeIdsSet = new Set(
        nodes.filter((node) => !!node.data.parentNodeId).map((node) => node.data.nodeId)
      );

      const dagreGraph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
      dagreGraph.setGraph({
        rankdir: 'LR',
        nodesep: 80,
        ranksep: 200
      });

      nodes.forEach((node) => {
        if (childNodeIdsSet.has(node.data.nodeId)) return;
        dagreGraph.setNode(node.id, { width: node.width!, height: node.height! });
      });

      // Find connected nodes
      const filteredEdges = edges.filter(
        (edge) => !childNodeIdsSet.has(edge.source) && !childNodeIdsSet.has(edge.target)
      );
      const connectedNodeIds = new Set<string>();
      filteredEdges.forEach((edge) => {
        connectedNodeIds.add(edge.source);
        connectedNodeIds.add(edge.target);
        dagreGraph.setEdge(edge.source, edge.target);
      });

      dagre.layout(dagreGraph);
      const layoutedStartNode = dagreGraph.node(startNode.data.nodeId);
      const offsetX = startPosition.x - (layoutedStartNode.x - startNode.width! / 2);
      const offsetY = startPosition.y - (layoutedStartNode.y - startNode.height! / 2);

      // Group nodes by rank (horizontal position in LR layout)
      const nodesByRank: Map<
        number,
        Array<{ node: Node<FlowNodeItemType>; dagreNode: any }>
      > = new Map();

      nodes.forEach((node) => {
        if (!connectedNodeIds.has(node.id) || childNodeIdsSet.has(node.data.nodeId)) {
          return;
        }

        const nodeWithPosition = dagreGraph.node(node.id);
        const rank = Math.round(nodeWithPosition.x); // Group by x coordinate (same column)

        if (!nodesByRank.has(rank)) {
          nodesByRank.set(rank, []);
        }
        nodesByRank.get(rank)!.push({ node, dagreNode: nodeWithPosition });
      });

      // Apply left-aligned positioning for nodes in same column (vertical stacking)
      const nodesMap = new Map(nodes.map((n) => [n.id, n]));
      nodesByRank.forEach((nodesInRank) => {
        // Find the minimum left position (for left alignment)
        let minLeft = Infinity;
        nodesInRank.forEach(({ node, dagreNode }) => {
          const left = dagreNode.x - node.width! / 2;
          minLeft = Math.min(minLeft, left);
        });

        // Sort nodes: use handle index for special nodes, otherwise maintain original Y position
        nodesInRank.sort((a, b) => {
          const edgeA = filteredEdges.find((e) => e.target === a.node.id);
          const edgeB = filteredEdges.find((e) => e.target === b.node.id);
          const sourceA = nodesMap.get(edgeA?.source);
          const sourceB = nodesMap.get(edgeB?.source);

          // Check if sources are special nodes (ifElse, userSelect, classifyQuestion)
          const specialNodeTypes = [
            FlowNodeTypeEnum.ifElseNode,
            FlowNodeTypeEnum.userSelect,
            FlowNodeTypeEnum.classifyQuestion
          ];
          const isSourceASpecial = sourceA && specialNodeTypes.includes(sourceA.data.flowNodeType);
          const isSourceBSpecial = sourceB && specialNodeTypes.includes(sourceB.data.flowNodeType);

          // If both from special nodes or both from regular nodes with same source, use handle index
          if (
            edgeA?.source === edgeB?.source &&
            (isSourceASpecial || isSourceBSpecial || !sourceA || !sourceB)
          ) {
            return getHandleIndex(edgeA, sourceA) - getHandleIndex(edgeB, sourceB);
          }

          // Otherwise, maintain original Y position order
          return a.dagreNode.y - b.dagreNode.y;
        });

        // Assign Y positions in sorted order
        let currentY =
          Math.min(...nodesInRank.map(({ dagreNode, node }) => dagreNode.y - node.height! / 2)) +
          offsetY;
        nodesInRank.forEach(({ node }) => {
          const targetX = minLeft + offsetX;
          const diffX = targetX - node.position.x;
          const diffY = currentY - node.position.y;

          node.position = { x: targetX, y: currentY };
          currentY += node.height! + 80;

          // Sync child nodes position
          nodes.forEach((childNode) => {
            if (childNode.data.parentNodeId === node.data.nodeId) {
              childNode.position = {
                x: childNode.position.x + diffX,
                y: childNode.position.y + diffY
              };
            }
          });
        });
      });
    };

    const newNodes = cloneDeep(getNodes()) as Node<FlowNodeItemType>[];
    const edges = getEdges();
    const previousPositions = new Map(
      newNodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }])
    );
    const childNodesIdSet = new Set<string>();

    // 1. Layout child nodes
    const childNodesMap: Record<string, Node<FlowNodeItemType>[]> = {};
    newNodes.forEach((node) => {
      const parentId = node.data.parentNodeId;
      if (parentId) {
        if (!node.width || !node.height) return;
        childNodesIdSet.add(parentId);
        (childNodesMap[parentId] ??= []).push(node);
      }
    });
    Object.values(childNodesMap).forEach((childNodes) => {
      updateChildNodesPosition({ startNode: childNodes[0], nodes: childNodes, edges });
    });

    // 2. Reset parent node size and position. Dimensions remain renderer-local;
    // container size persistence is intentionally outside this ticket.
    const parentNodes = newNodes.filter((node) => childNodesIdSet.has(node.data.nodeId));
    parentNodes.forEach((node) => {
      const res = getParentNodeSizeAndPosition({ nodes: newNodes, parentId: node.data.nodeId });
      if (!res) return;
      node.position = { x: res.parentX, y: res.parentY };
      node.width = res.nodeWidth;
      node.height = res.nodeHeight;
    });

    // 3. Layout parent node
    const startNode = newNodes.find((node) =>
      [FlowNodeTypeEnum.workflowStart, FlowNodeTypeEnum.pluginInput].includes(
        node.data.flowNodeType
      )
    );
    if (startNode || newNodes[0]) {
      updateParentNodesPosition({
        startNode: startNode || newNodes[0],
        nodes: newNodes,
        edges
      });
    }

    setNodes(newNodes);
    canvas.commitGeometry(
      newNodes.flatMap((node) => {
        const previous = previousPositions.get(node.id);
        return previous && (previous.x !== node.position.x || previous.y !== node.position.y)
          ? [{ nodeId: node.data.nodeId, position: node.position }]
          : [];
      })
    );

    setTimeout(() => {
      const validNodes = newNodes.filter((node) => node.width && node.height);
      fitView({ nodes: validNodes, padding: 0.3 });
    });
  }, [canvas, fitView, getEdges, getNodes, setNodes]);

  const onAddComment = useCallback(() => {
    // Compensate for menu position offset (set in onPaneContextMenu)
    // menu.left = e.clientX - 12, menu.top = e.clientY + 6
    const mouseX = (menu?.left ?? 0) + 12;
    const mouseY = (menu?.top ?? 0) - 6;

    const newNode = nodeTemplate2FlowNode({
      template: CommentNode,
      position: screenToFlowPosition({ x: mouseX, y: mouseY }),
      t
    });

    setNodes((state) => state.map((node) => ({ ...node, selected: false })));
    workflow.addNode(canvasNodeToStoreNode(newNode));
  }, [menu, screenToFlowPosition, setNodes, t, workflow]);

  const onFold = useCallback(() => {
    canvas.commitGeometry(
      (reader?.nodes ?? [])
        .filter((node) => node.flowNodeType !== FlowNodeTypeEnum.comment)
        .map((node) => ({ nodeId: node.nodeId, isFolded: !allNodeFolded }))
    );
  }, [allNodeFolded, canvas, reader]);

  return (
    <Box>
      <Box
        position={'fixed'}
        top={`${menu.top - 6}px`}
        left={`${menu.left + 10}px`}
        width={0}
        height={0}
        borderLeft="6px solid transparent"
        borderRight="6px solid transparent"
        borderBottom="6px solid white"
        zIndex={10}
        filter="drop-shadow(0px -1px 2px rgba(0, 0, 0, 0.1))"
      />
      <Box
        position={'fixed'}
        top={menu.top}
        left={menu.left}
        bg={'white'}
        w={'120px'}
        rounded={'md'}
        boxShadow={'0px 2px 4px 0px #A1A7B340'}
        color={'myGray.600'}
        p={1}
        zIndex={10}
      >
        <ContextMenuItem
          mb={1}
          icon="alignLeft"
          label={t('workflow:auto_align')}
          onClick={onLayout}
        />
        <ContextMenuItem
          mb={1}
          icon="comment"
          label={t('workflow:context_menu.add_comment')}
          onClick={onAddComment}
        />
        <ContextMenuItem
          icon="common/select"
          label={allNodeFolded ? t('workflow:unFoldAll') : t('workflow:foldAll')}
          onClick={onFold}
        />
      </Box>
    </Box>
  );
};

export default React.memo(ContextMenu);
