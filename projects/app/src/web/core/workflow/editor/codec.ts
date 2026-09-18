import type { AppChatConfigType } from '@fastgpt/global/core/app/type';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import type { TFunction } from 'i18next';
import {
  hydrateWorkflowEditor,
  migrateStoreWorkflow,
  serializeWorkflowEditor,
  type StoreWorkflow
} from '@fastgpt/global/core/workflow/editor/protocol';
import type { WorkflowRuntimePort } from '@fastgpt/global/core/workflow/editor/types';
import { storeNode2FlowNode } from '@/web/core/workflow/utils';
import { uiWorkflow2StoreWorkflow } from '@/pageComponents/app/detail/WorkflowComponents/utils';
import type { Edge, Node } from 'reactflow';
import {
  StoreNodeItemTypeSchema,
  type FlowNodeItemType
} from '@fastgpt/global/core/workflow/type/node';
import type { CanonicalWorkflowData } from '@fastgpt/global/core/workflow/migration';

type HydrateWorkflowEditorOptions = {
  input: unknown;
  chatConfig?: AppChatConfigType;
  t: TFunction;
};

/**
 * 入站边界（ADR 0001）：migration 之后做 Template Materialization，剥离画布专用字段，
 * 得到严格 canonical 数据。模板目录与 i18n 都留在边界外；保存时归一化（工具序列化、
 * 引用裁剪）只发生在出站边界，入站提前执行会把未水合数据当成用户编辑结果处理。
 * hydrate 与版本切换（replaceDocument）共用同一份物化结果。
 */
export const materializeWorkflow = ({
  input,
  chatConfig,
  t
}: HydrateWorkflowEditorOptions): CanonicalWorkflowData => {
  const workflow = migrateStoreWorkflow(
    chatConfig ? { ...(input as Record<string, unknown>), chatConfig } : input
  );
  // [workflow-runtime-cutover] 临时转换：入站过滤历史遗留的悬挂边；旧保存路径同样会在导出时过滤。
  const nodeIds = new Set(workflow.nodes.map((node) => node.nodeId));
  const canonicalEdges = workflow.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
  );
  const toolNodeIds = new Set(
    canonicalEdges
      .filter((edge) => edge.targetHandle === NodeOutputKeyEnum.selectedTools)
      .map((edge) => edge.target)
  );
  // [workflow-runtime-cutover] 临时 Materialization：复用旧 initData 的模板物化，
  // 保证字段命令按 key 能解析到模板新增而存量数据缺失的字段（ADR 0001）。
  const nodes = workflow.nodes.map((node) => {
    const flowNode = storeNode2FlowNode({
      item: node,
      isTool: toolNodeIds.has(node.nodeId),
      t
    });
    // [workflow-runtime-cutover] 临时转换：canonical schema 剥离画布/模板专用字段，
    // 语义值保持物化结果原样，不在此处执行保存时归一化。
    return StoreNodeItemTypeSchema.parse({ ...flowNode.data, position: flowNode.position });
  });

  // 物化会重新引入模板默认的容器尺寸字段，再走一次 migration 统一清理，保证严格 canonical。
  return migrateStoreWorkflow({ nodes, edges: canonicalEdges, chatConfig: workflow.chatConfig });
};

/** 保存、发布、本地草稿、离开确认和调试共用的编辑器入口：物化后创建 Runtime。 */
export const hydrateRuntime = ({
  input,
  chatConfig,
  t
}: HydrateWorkflowEditorOptions): WorkflowRuntimePort =>
  hydrateWorkflowEditor(materializeWorkflow({ input, chatConfig, t }));

/**
 * 出站边界：读取 Runtime 完整导出，并用旧保存路径的 Workflow Normalization 原样包住
 * （工具输入模式归一、工具选择序列化、图相关不可选引用裁剪、按节点存在性过滤边、剥离画布函数字段）。
 */
export const serializeRuntime = (runtime: WorkflowRuntimePort): StoreWorkflow => {
  const data = serializeWorkflowEditor(runtime);
  // [workflow-runtime-cutover] 临时转换：把 Runtime 导出包装成 reactflow 形状，
  // 直接复用 uiWorkflow2StoreWorkflow，一行不改既有归一化行为。
  const normalized = uiWorkflow2StoreWorkflow({
    nodes: data.nodes.map((node) => ({
      id: node.nodeId,
      position: node.position ?? { x: 0, y: 0 },
      data: node
    })) as Node<FlowNodeItemType, string | undefined>[],
    edges: data.edges as Edge<any>[],
    chatConfig: data.chatConfig
  });

  return { ...normalized, chatConfig: data.chatConfig } as StoreWorkflow;
};
