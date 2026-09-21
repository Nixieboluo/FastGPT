import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import { useReactFlow, type Node } from 'reactflow';
import NodeTemplateListHeader from './components/NodeTemplates/header';
import NodeTemplateList from './components/NodeTemplates/list';
import { useNodeTemplates } from './components/NodeTemplates/useNodeTemplates';
import { buildNodeTemplateContext } from '@fastgpt/global/core/workflow/template/context';
import { useMemoizedFn } from 'ahooks';
import React from 'react';
import { useContextSelector } from 'use-context-selector';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import { useWorkflow as useWorkflowAdapter } from '@/web/core/workflow/editor';
import { canvasNodeToStoreNode } from '@/web/core/workflow/editor/canvas';
import AppDetailPanelModal from '../../components/AppDetailPanelModal';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import { useDocumentGetNodeById, useWorkflowDocument } from './nodes/render/useWorkflowDocument';

type ModuleTemplateListProps = {
  isOpen: boolean;
  onClose: () => void;
};

export const sliderWidth = 460;

const NodeTemplatesModal = ({ isOpen, onClose }: ModuleTemplateListProps) => {
  /** 新增节点后立即复查问题文案，不等 host 的 10s 定时扫描。 */
  const refreshNodeIssues = useContextSelector(WorkflowHostContext, (v) => v.refreshNodeIssues);
  const workflow = useWorkflowAdapter();
  const { setNodes } = useReactFlow();
  const getNodeById = useDocumentGetNodeById();
  const nodeList = useWorkflowDocument().reader?.nodes;
  // 模板目录按画布级存在性标记过滤：工具调用与循环执行入口容器各自唯一。
  const hasToolNode = !!nodeList?.some((node) => node.flowNodeType === FlowNodeTypeEnum.toolCall);
  const hasLoopRunNode = !!nodeList?.some((node) => node.flowNodeType === FlowNodeTypeEnum.loopRun);

  const templateContext = React.useMemo(
    () =>
      buildNodeTemplateContext({
        sourceNode: undefined,
        edges: workflow.edges,
        getNodeById,
        isSidebar: true,
        hasToolNode,
        hasLoopRunNode
      }),
    [workflow.edges, getNodeById, hasToolNode, hasLoopRunNode]
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
    selectedTagIds,
    setSelectedTagIds,
    toolTags
  } = useNodeTemplates(templateContext);

  const onAddNode = useMemoizedFn(async ({ newNodes }: { newNodes: Node<FlowNodeItemType>[] }) => {
    setNodes((state) => state.map((node) => ({ ...node, selected: false })));
    workflow.addNodes(newNodes.map(canvasNodeToStoreNode));

    // [TODO] probably can delegate to runtime problem views.
    // 新增节点后立即同步下方待完善提示，不依赖 10s 定时扫描或用户首次编辑。
    setTimeout(() => {
      refreshNodeIssues(newNodes[0]?.data.nodeId ?? '');
    }, 0);
  });

  return (
    <AppDetailPanelModal
      isOpen={isOpen}
      onClose={onClose}
      isLoading={templatesIsLoading}
      width={['100%', `${sliderWidth}px`]}
      height={['100vh', 'calc(100vh - 67px)']}
      top={[0, '67px']}
      position={'fixed'}
      placement={'left'}
      showMask={false}
      headerProps={{
        minH: 0,
        px: 0,
        pt: 5,
        flexDirection: 'column',
        alignItems: 'stretch',
        fontSize: 'sm'
      }}
      contentProps={{
        pb: 4,
        userSelect: 'none',
        fontSize: 'sm'
      }}
      header={
        <NodeTemplateListHeader
          onClose={onClose}
          templateType={templateType}
          onUpdateTemplateType={onUpdateTemplateType}
          parentId={parentId}
          parentSource={parentSource}
          searchKey={searchKey}
          setSearchKey={setSearchKey}
          onUpdateParentId={onUpdateParentId}
          selectedTagIds={selectedTagIds}
          setSelectedTagIds={setSelectedTagIds}
          toolTags={toolTags}
        />
      }
    >
      <NodeTemplateList
        onAddNode={onAddNode}
        templates={templates}
        templateType={templateType}
        onUpdateParentId={onUpdateParentId}
        ScrollData={TeamScrollData}
      />
    </AppDetailPanelModal>
  );
};

export default React.memo(NodeTemplatesModal);
