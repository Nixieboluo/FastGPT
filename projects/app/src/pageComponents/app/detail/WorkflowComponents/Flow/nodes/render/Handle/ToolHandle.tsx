import MyTooltip from '@fastgpt/web/components/common/MyTooltip';
import { Box, type BoxProps } from '@chakra-ui/react';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { useTranslation } from 'next-i18next';
import { type Connection, Handle, Position } from 'reactflow';
import { useCallback, useMemo } from 'react';
import { useContextSelector } from 'use-context-selector';
import { WorkflowUIContext } from '../../../context/workflowUIContext';
import {
  isConnectionTargetAllowed,
  useWorkflow as useWorkflowAdapter
} from '@/web/core/workflow/editor';
import { useWorkflowDocument } from '../useWorkflowDocument';

const handleSize = '20px';
const activeHandleSize = '24px';
const handleId = NodeOutputKeyEnum.selectedTools;

type ToolHandleProps = BoxProps & {
  nodeId: string;
  show: boolean;
};
export const ToolTargetHandle = ({ show, nodeId }: ToolHandleProps) => {
  // 工具柄的可连接判定要读任意源节点与父节点，走文档图 reader。
  const { reader } = useWorkflowDocument();
  const connectingEdge = useContextSelector(WorkflowUIContext, (ctx) => ctx.connectingEdge);
  const connected = !!reader?.edges.some(
    (edge) => edge.target === nodeId && edge.targetHandle === handleId
  );

  const active = useMemo(() => {
    if (!show || !reader || connectingEdge?.handleId !== handleId) return false;

    const { getNodeById } = reader;
    const sourceNode = getNodeById(connectingEdge.nodeId);
    const targetNode = getNodeById(nodeId);

    return (
      !!sourceNode &&
      !!targetNode &&
      // context 在连线拖拽开始时由 Runtime 算好，工具柄只按 target 应用纯规则。
      isConnectionTargetAllowed({
        context: connectingEdge.context,
        targetNode,
        sourceParentNodeId: sourceNode.parentNodeId
      })
    );
  }, [connectingEdge, nodeId, reader, show]);
  // if top handle is connected, return null
  const showHandle = active || connected;

  const size = active ? activeHandleSize : handleSize;

  const Render = useMemo(() => {
    return (
      <Handle
        style={{
          borderRadius: '0',
          backgroundColor: 'transparent',
          border: 'none',
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          top: active ? '-14px' : '-10px',
          zIndex: 30,
          ...(showHandle ? {} : { visibility: 'hidden' })
        }}
        type="target"
        id={handleId}
        position={Position.Top}
        isConnectableEnd={active}
        isConnectableStart={false}
      >
        <Box
          className="flow-handle"
          w={size}
          h={size}
          border={'4px solid #8774EE'}
          rounded={'xs'}
          bg={'white'}
          transform={'translate(0,0) rotate(45deg)'}
          pointerEvents={'none'}
        />
      </Handle>
    );
  }, [active, showHandle, size]);

  return Render;
};

export const ToolSourceHandle = ({ nodeId }: { nodeId: string }) => {
  const { t } = useTranslation();
  const workflow = useWorkflowAdapter();
  const { edges } = workflow;
  const connectingEdge = useContextSelector(
    WorkflowUIContext,
    (ctx) => ctx.connectingEdge?.nodeId === nodeId
  );
  const nodeIsHover = useContextSelector(WorkflowUIContext, (v) => v.hoverNodeId === nodeId);

  const active = useMemo(() => nodeIsHover || connectingEdge, [nodeIsHover, connectingEdge]);

  /* onConnect edge, delete tool input and switch */
  const onConnect = useCallback(
    (e: Connection) => {
      edges
        .filter(
          (edge) =>
            edge.target === e.target && edge.targetHandle !== NodeOutputKeyEnum.selectedTools
        )
        .forEach((edge) =>
          workflow.disconnectEdge({
            edge: {
              source: edge.source,
              target: edge.target,
              sourceHandle: edge.sourceHandle || '',
              targetHandle: edge.targetHandle || ''
            }
          })
        );
    },
    [edges, workflow]
  );

  const size = active ? activeHandleSize : handleSize;

  const Render = useMemo(() => {
    return (
      <MyTooltip label={t('common:core.workflow.tool.Handle')} shouldWrapChildren={false}>
        <Handle
          style={{
            borderRadius: '0',
            backgroundColor: 'transparent',
            border: 'none',
            width: size,
            height: size,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bottom: active ? '-14px' : '-10px',
            zIndex: 30
          }}
          type="source"
          id={NodeOutputKeyEnum.selectedTools}
          position={Position.Bottom}
          onConnect={onConnect}
        >
          <Box
            w={size}
            h={size}
            border={'4px solid #8774EE'}
            rounded={'xs'}
            bg={'white'}
            transform={'translate(0,0) rotate(45deg)'}
            pointerEvents={'none'}
          />
        </Handle>
      </MyTooltip>
    );
  }, [active, onConnect, size, t]);

  return Render;
};

export default function Dom() {
  return <></>;
}
