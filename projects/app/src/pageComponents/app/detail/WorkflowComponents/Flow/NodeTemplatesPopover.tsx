import { Popover, PopoverBody, PopoverContent } from '@chakra-ui/react';
import { getNanoid } from '@fastgpt/global/common/string/tools';
import {
  EDGE_TYPE,
  FlowNodeTypeEnum,
  isNestedChildSystemNodeType
} from '@fastgpt/global/core/workflow/node/constant';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { buildNodeTemplateContext } from '@fastgpt/global/core/workflow/template/context';
import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import MyBox from '@fastgpt/web/components/common/MyBox';
import { useMemoizedFn } from 'ahooks';
import React from 'react';
import { type Node } from 'reactflow';
import { useContextSelector } from 'use-context-selector';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import { useWorkflow as useWorkflowAdapter } from '@/web/core/workflow/editor';
import { canvasNodeToStoreNode } from '@/web/core/workflow/editor/cutover/translate';
import { WorkflowBufferDataContext } from '../context/workflowInitContext';
import { WorkflowModalContext } from './context/workflowModalContext';
import NodeTemplateListHeader from './components/NodeTemplates/header';
import NodeTemplateList from './components/NodeTemplates/list';
import { useNodeTemplates } from './components/NodeTemplates/useNodeTemplates';
import { popoverHeight, popoverWidth } from './hooks/useWorkflow';

const NodeTemplatesPopover = () => {
  const { handleParams, setHandleParams } = useContextSelector(WorkflowModalContext, (v) => v);

  const { setNodes, edges, getNodeById, hasToolNode, hasLoopRunNode } = useContextSelector(
    WorkflowBufferDataContext,
    (v) => v
  );
  /** 新增节点后立即复查问题文案，不等 host 的 10s 定时扫描。 */
  const refreshNodeIssues = useContextSelector(WorkflowHostContext, (v) => v.refreshNodeIssues);
  const workflow = useWorkflowAdapter();

  const nodeTemplateContext = React.useMemo(
    () =>
      buildNodeTemplateContext({
        sourceNode: handleParams?.nodeId ? getNodeById(handleParams.nodeId) : undefined,
        edges,
        handleId: handleParams?.handleId,
        getNodeById,
        hasToolNode,
        hasLoopRunNode
      }),
    [handleParams, edges, getNodeById, hasToolNode, hasLoopRunNode]
  );

  const {
    templateType,
    parentId,
    parentSource,
    searchKey,
    setSearchKey,
    templatesIsLoading,
    templates,
    TeamScrollData,
    onUpdateTemplateType,
    onUpdateParentId,
    toolTags,
    selectedTagIds,
    setSelectedTagIds
  } = useNodeTemplates(nodeTemplateContext);

  const onAddNode = useMemoizedFn(async ({ newNodes }: { newNodes: Node<FlowNodeItemType>[] }) => {
    const isToolHandle = handleParams?.handleId === NodeOutputKeyEnum.selectedTools;
    // 容器（循环/并行）自带的开始/结束系统子节点随父节点一起添加，不参与工具可用性过滤。
    const batchNodeIds = new Set(newNodes.map((node) => node.id));
    const validNewNodes = newNodes.filter((node) => {
      if (node.data.parentNodeId && batchNodeIds.has(node.data.parentNodeId)) return true;
      if (!isToolHandle && node.data.flowNodeType === FlowNodeTypeEnum.toolSet) return false;
      if (isToolHandle && !node.data.isTool) return false;
      return true;
    });

    if (validNewNodes.length === 0) {
      setHandleParams(null);
      return;
    }

    const storeNodes = validNewNodes.map(canvasNodeToStoreNode);
    setNodes((state) => state.map((node) => ({ ...node, selected: false })));
    workflow.addNodes(storeNodes);

    if (!handleParams) return;

    const newEdges = validNewNodes
      .filter((node) => !isNestedChildSystemNodeType(node.data.flowNodeType))
      .map((node) => ({
        id: getNanoid(),
        source: handleParams.nodeId as string,
        sourceHandle: handleParams.handleId,
        target: node.id,
        targetHandle: isToolHandle ? 'selectedTools' : `${node.id}-target-left`,
        type: EDGE_TYPE
      }));

    newEdges.forEach((edge) =>
      workflow.connectEdge({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle || '',
        targetHandle: edge.targetHandle || ''
      })
    );

    setHandleParams(null);

    setTimeout(() => {
      validNewNodes.forEach((node) => {
        refreshNodeIssues(node.data.nodeId);
      });
    }, 0);
  });

  if (!handleParams) return null;

  return (
    <Popover
      isOpen={!!handleParams}
      onClose={() => setHandleParams(null)}
      closeOnBlur={true}
      closeOnEsc={true}
      autoFocus={true}
      isLazy
    >
      <PopoverContent
        position="fixed"
        top={`${handleParams.popoverPosition.y}px`}
        left={`${handleParams.popoverPosition.x + 10}px`}
        width={popoverWidth}
        height={popoverHeight}
        boxShadow="3px 0 20px rgba(0,0,0,0.2)"
        border={'none'}
      >
        <PopoverBody padding={0} h={'full'}>
          <MyBox
            isLoading={templatesIsLoading}
            display={'flex'}
            flexDirection={'column'}
            py={4}
            h={'full'}
            minH={0}
            userSelect="none"
          >
            <NodeTemplateListHeader
              isPopover={true}
              templateType={templateType}
              onUpdateTemplateType={onUpdateTemplateType}
              parentId={parentId}
              parentSource={parentSource}
              onUpdateParentId={onUpdateParentId}
              searchKey={searchKey}
              setSearchKey={setSearchKey}
              toolTags={toolTags}
              selectedTagIds={selectedTagIds}
              setSelectedTagIds={setSelectedTagIds}
            />
            <NodeTemplateList
              onAddNode={onAddNode}
              isPopover={true}
              templates={templates}
              templateType={templateType}
              onUpdateParentId={onUpdateParentId}
              ScrollData={TeamScrollData}
            />
          </MyBox>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
};

export default React.memo(NodeTemplatesPopover);
