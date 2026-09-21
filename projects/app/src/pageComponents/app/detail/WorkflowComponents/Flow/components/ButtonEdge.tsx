import React, { useCallback, useMemo, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  useReactFlow,
  type EdgeProps,
  type ConnectionLineComponentProps
} from 'reactflow';
import { Box, Flex } from '@chakra-ui/react';
import MyIcon from '@fastgpt/web/components/common/Icon';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { useContextSelector } from 'use-context-selector';
import { useThrottleEffect } from 'ahooks';
import { WorkflowDebugContext } from '../../context/workflowDebugContext';
import { WorkflowUIContext } from '../context/workflowUIContext';
import { WorkflowSelectionContext } from '../context/workflowSelectionContext';
import { getCustomStepPath } from '../utils/edge';
import { useNode, useWorkflow as useWorkflowAdapter } from '@/web/core/workflow/editor';

export const CustomConnectionLine = ({
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition
}: ConnectionLineComponentProps) => {
  const [path] = getCustomStepPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
    borderRadius: 60
  });

  return (
    <g>
      <path d={path} fill="none" stroke="#487FFF" strokeWidth={3} />
    </g>
  );
};

const ButtonEdge = (props: EdgeProps) => {
  const selectedNodesMap = useContextSelector(WorkflowSelectionContext, (v) => v.selectedNodesMap);
  const workflowDebugData = useContextSelector(WorkflowDebugContext, (v) => v.workflowDebugData);
  const hoverEdgeId = useContextSelector(WorkflowUIContext, (v) => v.hoverEdgeId);
  const workflow = useWorkflowAdapter();
  // 同源边的横向错开与断连都按端点值工作，画布边数组只从 reactflow store 取，
  // 投影边 id 不进 adapter；workflow.edges 只作为「结构变了要重算」的依赖。
  const { getNodes, getEdges, getEdge } = useReactFlow();

  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    source,
    sourceHandleId,
    target,
    targetHandleId,
    style
  } = props;

  // 端点所在容器折叠时隐藏整条边；容器 id 优先取 source，与旧实现一致。
  const sourceParentId = useNode(source)?.data.parentNodeId;
  const targetParentId = useNode(target)?.data.parentNodeId;
  const foldParentId = sourceParentId ?? targetParentId;
  const isFolded = !!useNode(foldParentId ?? '')?.view.isFolded;

  const defaultZIndex = sourceParentId ? 2002 : 0;

  // Offset edges from same source horizontally to avoid visual overlap
  const edgeStepOffset = useMemo(() => {
    const sameSourceEdges = getEdges().filter((e) => e.source === source);
    if (sameSourceEdges.length <= 1) return 0;

    const nodesMap = new Map(getNodes().map((n) => [n.id, n]));

    // Sort edges by target node Y position
    const sortedEdges = [...sameSourceEdges].sort((a, b) => {
      const nodeA = nodesMap.get(a.target);
      const nodeB = nodesMap.get(b.target);
      return (nodeA?.position?.y ?? 0) - (nodeB?.position?.y ?? 0);
    });

    const index = sortedEdges.findIndex((e) => e.id === id);
    const total = sortedEdges.length;
    const spacing = 20;
    const midPoint = Math.ceil(total / 2);
    const offset =
      index < midPoint
        ? (index - Math.floor(midPoint / 2)) * spacing
        : (Math.floor((total - midPoint) / 2) - (index - midPoint)) * spacing;

    const maxOffset = Math.abs(targetX - sourceX) * 0.25;
    return Math.max(-maxOffset, Math.min(maxOffset, offset));
    // workflow.edges 是刻意的依赖：结构变化后 store 里的画布边才是新的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.edges, source, id, getNodes, getEdges, sourceX, targetX]);

  const onDelConnect = useCallback(
    (id: string) => {
      const edge = getEdge(id);
      if (!edge) return;
      workflow.disconnectEdge({
        edge: {
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle || '',
          targetHandle: edge.targetHandle || ''
        }
      });
    },
    [getEdge, workflow]
  );

  // Selected edge or source/target node selected
  const [highlightEdge, setHighlightEdge] = useState(false);
  useThrottleEffect(
    () => {
      const isSourceSelected = selectedNodesMap[props.source];
      const isTargetSelected = selectedNodesMap[props.target];
      setHighlightEdge(isSourceSelected || isTargetSelected || !!selected);
    },
    [selectedNodesMap, props.source, props.target, selected],
    {
      wait: 100
    }
  );

  const [, labelX, labelY] = getCustomStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    stepOffset: edgeStepOffset
  });

  const isToolEdge = sourceHandleId === NodeOutputKeyEnum.selectedTools;
  const isHover = hoverEdgeId === id;

  const { newTargetX, newTargetY } = useMemo(() => {
    if (targetPosition === 'left') {
      return {
        newTargetX: targetX - 7,
        newTargetY: targetY
      };
    }
    return {
      newTargetX: targetX,
      newTargetY: targetY
    };
  }, [targetPosition, targetX, targetY]);

  const edgeColor = useMemo(() => {
    const targetEdge = workflowDebugData?.runtimeEdges.find(
      (edge) => edge.sourceHandle === sourceHandleId && edge.targetHandle === targetHandleId
    );
    if (!targetEdge) {
      if (highlightEdge) return '#487FFF';
      return '#94B5FF';
    }

    // debug mode
    const colorMap = {
      active: '#487FFF',
      waiting: '#5E8FFF',
      skipped: '#8A95A7'
    };
    return colorMap[targetEdge.status];
  }, [highlightEdge, sourceHandleId, targetHandleId, workflowDebugData?.runtimeEdges]);

  const memoEdgeLabel = useMemo(() => {
    const arrowTransform = (() => {
      if (targetPosition === 'left') {
        return `translate(-89%, -49%) translate(${newTargetX}px,${newTargetY}px) rotate(0deg)`;
      }
      if (targetPosition === 'right') {
        return `translate(-10%, -50%) translate(${newTargetX}px,${newTargetY}px) rotate(-180deg)`;
      }
      if (targetPosition === 'bottom') {
        return `translate(-50%, -20%) translate(${newTargetX}px,${newTargetY}px) rotate(-90deg)`;
      }
      if (targetPosition === 'top') {
        return `translate(-50%, -90%) translate(${newTargetX}px,${newTargetY}px) rotate(90deg)`;
      }
    })();

    return (
      <EdgeLabelRenderer>
        <Box hidden={isFolded}>
          <Flex
            display={isHover || highlightEdge ? 'flex' : 'none'}
            alignItems={'center'}
            justifyContent={'center'}
            position={'absolute'}
            transform={`translate(-55%, -50%) translate(${labelX}px,${labelY}px)`}
            pointerEvents={'all'}
            w={'26px'}
            h={'26px'}
            bg={'white'}
            borderRadius={'18px'}
            cursor={'pointer'}
            zIndex={defaultZIndex + 1000}
            onClick={() => onDelConnect(id)}
          >
            <MyIcon name={'core/workflow/closeEdge'} w={'100%'}></MyIcon>
          </Flex>
          {!isToolEdge && (
            <Flex
              alignItems={'center'}
              justifyContent={'center'}
              position={'absolute'}
              transform={arrowTransform}
              pointerEvents={'all'}
              w={highlightEdge ? '18px' : '16px'}
              h={highlightEdge ? '18px' : '16px'}
              zIndex={highlightEdge ? defaultZIndex + 1000 : defaultZIndex}
            >
              <MyIcon
                name={highlightEdge ? 'core/workflow/edgeArrowBold' : 'core/workflow/edgeArrow'}
                w={'100%'}
                color={edgeColor}
              />
            </Flex>
          )}
        </Box>
      </EdgeLabelRenderer>
    );
  }, [
    isFolded,
    isHover,
    highlightEdge,
    labelX,
    labelY,
    defaultZIndex,
    isToolEdge,
    edgeColor,
    targetPosition,
    newTargetX,
    newTargetY,
    onDelConnect,
    id
  ]);

  const memoBezierEdge = useMemo(() => {
    const targetEdge = workflowDebugData?.runtimeEdges.find(
      (edge) => edge.source === source && edge.target === target
    );

    const edgeStyle: React.CSSProperties = (() => {
      if (!targetEdge) {
        return {
          ...style,
          ...(highlightEdge
            ? {
                strokeWidth: 4
              }
            : { strokeWidth: 3, zIndex: 2 })
        };
      }

      return {
        ...style,
        strokeWidth: 3
      };
    })();

    const [path] = getCustomStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX: newTargetX,
      targetY: newTargetY,
      targetPosition,
      borderRadius: 60,
      stepOffset: edgeStepOffset
    });

    return (
      <BaseEdge
        id={id}
        path={path}
        style={{
          ...edgeStyle,
          stroke: edgeColor,
          display: isFolded ? 'none' : 'block'
        }}
      />
    );
  }, [
    workflowDebugData?.runtimeEdges,
    id,
    sourceX,
    sourceY,
    sourcePosition,
    newTargetX,
    newTargetY,
    targetPosition,
    edgeColor,
    edgeStepOffset,
    source,
    target,
    style,
    highlightEdge,
    isFolded
  ]);

  return (
    <>
      {memoBezierEdge}
      {memoEdgeLabel}
    </>
  );
};

export default React.memo(ButtonEdge);
