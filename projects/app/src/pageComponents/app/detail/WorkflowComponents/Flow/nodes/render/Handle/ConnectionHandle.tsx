import React, { useMemo } from 'react';
import { Position } from 'reactflow';
import { MySourceHandle, MyTargetHandle } from '.';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import { NodeInputKeyEnum, NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { moduleTemplatesFlat } from '@fastgpt/global/core/workflow/template/constants';
import { isNodeConnectionAllowed } from '@fastgpt/global/core/workflow/template/context';
import { useContextSelector } from 'use-context-selector';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import type { IfElseListItemType } from '@fastgpt/global/core/workflow/template/system/ifElse/type';
import { getIfElseBranchHandleKey } from '@fastgpt/global/core/workflow/template/system/ifElse/utils';
import { useNode, useWorkflow } from '@/web/core/workflow/editor';
import { WorkflowUIContext } from '../../../context/workflowUIContext';
import { useWorkflowDocument } from '../useWorkflowDocument';

export const ConnectionSourceHandle = ({
  nodeId,
  sourceType = 'source'
}: {
  nodeId: string;
  sourceType?: 'source' | 'source_catch';
}) => {
  const nodeHandle = useNode(nodeId);
  const { edges } = useWorkflow();
  const connectingEdge = useContextSelector(WorkflowUIContext, (v) => v.connectingEdge);

  const { showSourceHandle, RightHandle } = useMemo(() => {
    const node = nodeHandle?.data;

    /* not node/not connecting node, hidden */
    const showSourceHandle = (() => {
      if (!node) return false;
      if (connectingEdge && connectingEdge.nodeId !== nodeId) return false;
      return true;
    })();

    const RightHandle = (() => {
      // When the node is folded and has multiple branches, only render the first output.
      if (node && nodeHandle?.view.isFolded) {
        const firstHandleId = (() => {
          if (node.flowNodeType === FlowNodeTypeEnum.userSelect) {
            const options = node?.inputs?.find(
              (input) => input.key === NodeInputKeyEnum.userSelectOptions
            )?.value;
            if (options && options.length > 0) {
              return getHandleId(nodeId, 'source', options[0].key);
            }
          } else if (node.flowNodeType === FlowNodeTypeEnum.ifElseNode) {
            const ifElseList = node.inputs.find(
              (input) => input.key === NodeInputKeyEnum.ifElseList
            )?.value as IfElseListItemType[] | undefined;
            const firstIfElse = ifElseList?.[0];
            if (firstIfElse) {
              return getHandleId(nodeId, 'source', getIfElseBranchHandleKey(firstIfElse));
            }
          } else if (node.flowNodeType === FlowNodeTypeEnum.classifyQuestion) {
            const options = node?.inputs?.find(
              (input) => input.key === NodeInputKeyEnum.agents
            )?.value;
            if (options && options.length > 0) {
              return getHandleId(nodeId, 'source', options[0].key);
            }
          }
        })();

        if (firstHandleId) {
          return (
            <MySourceHandle
              nodeId={nodeId}
              handleId={firstHandleId}
              position={Position.Right}
              translate={[4, 0]}
            />
          );
        }
      }

      const handleId = getHandleId(nodeId, sourceType, Position.Right);
      const rightTargetConnected = edges.some(
        (edge) => edge.targetHandle === getHandleId(nodeId, 'target', Position.Right)
      );

      // 连接柄显隐由当前模板决定：文档节点不携带模板展示字段。
      const templateShowSourceHandle = node
        ? moduleTemplatesFlat.find((item) => item.flowNodeType === node.flowNodeType)
            ?.showSourceHandle
        : undefined;
      if (!node || !templateShowSourceHandle || rightTargetConnected) {
        return null;
      }

      return (
        <MySourceHandle
          nodeId={nodeId}
          handleId={handleId}
          position={Position.Right}
          translate={[4, 0]}
        />
      );
    })();

    return {
      showSourceHandle,
      RightHandle
    };
  }, [nodeHandle, nodeId, connectingEdge, sourceType, edges]);

  return showSourceHandle ? <>{RightHandle}</> : null;
};

export const ConnectionTargetHandle = React.memo(function ConnectionTargetHandle({
  nodeId
}: {
  nodeId: string;
}) {
  // 目标柄要按任意父节点判定容器上下文，用文档图 reader 一次取全，不逐个 useNode。
  const { reader } = useWorkflowDocument();
  const connectingEdge = useContextSelector(WorkflowUIContext, (v) => v.connectingEdge);

  const { LeftHandle } = useMemo(() => {
    if (!reader) return { LeftHandle: null };
    const { edges, getNodeById } = reader;
    const node = getNodeById(nodeId);
    const connectingNode = getNodeById(connectingEdge?.nodeId);

    let forbidConnect = false;
    for (const edge of edges) {
      if (forbidConnect) break;

      if (edge.target === nodeId) {
        // Node has be connected tool, it cannot be connect by other handle
        if (edge.targetHandle === NodeOutputKeyEnum.selectedTools) {
          forbidConnect = true;
        }
        // The same source handle cannot connect to the same target node
        if (
          connectingEdge &&
          connectingEdge.handleId === edge.sourceHandle &&
          edge.target === nodeId
        ) {
          forbidConnect = true;
        }
      }
    }

    // 目标节点容器或模板上下文不允许时禁止连接（与 Tool 柄及最终提交共用规则）
    const sourceNode = connectingEdge ? getNodeById(connectingEdge.nodeId) : undefined;
    const targetTemplate = node
      ? moduleTemplatesFlat.find((item) => item.id === node.flowNodeType)
      : undefined;
    if (node && sourceNode && connectingEdge) {
      if (
        !isNodeConnectionAllowed({
          targetTemplate,
          targetNode: node,
          sourceNode,
          edges,
          handleId: connectingEdge.handleId,
          getNodeById
        })
      ) {
        forbidConnect = true;
      }
    }

    const showHandle = (() => {
      if (forbidConnect) return false;
      if (!node) return false;

      // Tool connecting
      if (connectingEdge && connectingEdge.handleId === NodeOutputKeyEnum.selectedTools)
        return false;

      // Unable to connect oneself
      if (connectingEdge && connectingEdge.nodeId === nodeId) return false;
      // Not the same parent node
      if (connectingNode && connectingNode?.parentNodeId !== node?.parentNodeId) return false;

      return true;
    })();

    const LeftHandle = (() => {
      // 同 source 柄：显隐看当前模板，文档节点不携带模板展示字段。
      const showTargetHandle = node
        ? moduleTemplatesFlat.find((item) => item.flowNodeType === node.flowNodeType)
            ?.showTargetHandle
        : undefined;
      if (!node || !showTargetHandle) return null;

      const handleId = getHandleId(nodeId, 'target', Position.Left);

      return (
        <MyTargetHandle
          nodeId={nodeId}
          handleId={handleId}
          position={Position.Left}
          translate={[-4, 0]}
          showHandle={showHandle}
        />
      );
    })();

    return {
      showHandle,
      LeftHandle
    };
  }, [connectingEdge, nodeId, reader]);

  return <>{LeftHandle}</>;
});

export default function Dom() {
  return <></>;
}
