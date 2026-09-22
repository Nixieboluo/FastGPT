import type { TFunction } from 'next-i18next';
import type { Edge, Node } from 'reactflow';
import type { AppChatConfigType } from '@fastgpt/global/core/app/type';
import type { WorkflowIssueProvider } from '@fastgpt/global/core/workflow/editor/types';
import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import {
  checkWorkflowNodeIssues,
  type WorkflowCheckModel
} from '@/web/core/workflow/workflowCheck';

/**
 * Issue Provider 需要的 editor 环境。
 * provider 由 Runtime 同步调用，因此这里只能提供同步读取能力：模型目录读已就绪的缓存，
 * 文案函数等 editor 状态由 host 闭包（ref）提供，不通过 Runtime 传递。
 */
export type WorkflowIssueEnvironment = {
  /** 同步解析当前 workflow 引用的模型详情；目录未就绪返回 undefined。 */
  getModels: (
    nodes: { data: FlowNodeItemType }[],
    chatConfig?: AppChatConfigType
  ) => WorkflowCheckModel[] | undefined;
  getT: () => TFunction;
};

/**
 * 创建 editor 侧 Issue Provider：把只读 Workflow Snapshot 适配成现有校验器的画布形状，
 * 返回结构化 issue 交给 Runtime 与文档检查结果合并。
 * snapshot 节点是 DeepReadonly 的语义数据，校验器只读不写，因此按 FlowNodeItemType 直接透传；
 * id 与 position 只为满足 reactflow 形状，校验逻辑不读它们。
 */
export const createWorkflowIssueProvider =
  ({ getModels, getT }: WorkflowIssueEnvironment): WorkflowIssueProvider =>
  ({ workflow, nodeIds }) => {
    const nodes = workflow.nodes.map((node) => ({
      id: node.nodeId,
      position: { x: 0, y: 0 },
      data: node
    })) as unknown as Node<FlowNodeItemType, string | undefined>[];
    const chatConfig = workflow.chatConfig as AppChatConfigType;
    // 模型目录未就绪时不产出环境问题，等目录就绪后由 host 触发一次刷新补上。
    const models = getModels(nodes, chatConfig);
    if (!models) return [];
    const edges = workflow.edges.map((edge, index) => ({
      id: `wfedge-${index}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle
    })) as Edge<any>[];
    const issueMap = checkWorkflowNodeIssues({
      nodes,
      edges,
      models,
      nodeIds: nodeIds === 'all' ? undefined : nodeIds,
      t: getT(),
      chatConfig
    });
    return Object.values(issueMap).flat();
  };
