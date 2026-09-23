import { FlowNodeTypeEnum, isInteractiveNodeType, isNestedParentNodeType } from '../node/constant';
import type {
  FlowNodeTemplateType,
  FlowNodeItemType,
  NodeTemplateContext,
  NodeTemplateContextPredicate
} from '../type/node';

/**
 * 模板展示上下文规则：规则字段全部为空时匹配任何上下文。
 */
export type NodeTemplateContextRule = {
  sourceType?: FlowNodeTypeEnum;
  handleId?: string;
  parentType?: FlowNodeTypeEnum;
};

const matchRule = (rule: NodeTemplateContextRule, ctx: NodeTemplateContext): boolean => {
  if (rule.sourceType !== undefined && rule.sourceType !== ctx.sourceType) return false;
  if (rule.handleId !== undefined && rule.handleId !== ctx.handleId) return false;
  if (rule.parentType !== undefined && rule.parentType !== ctx.parentType) return false;
  return true;
};

/**
 * 白名单工厂：上下文存在且匹配任一规则时展示。
 */
export const createShowInContext = (
  rules: NodeTemplateContextRule[]
): NodeTemplateContextPredicate => {
  return (ctx) => !!ctx && rules.some((rule) => matchRule(rule, ctx));
};

/**
 * 黑名单工厂：匹配任一规则时隐藏；无上下文时展示。
 */
export const createHideInContext = (
  rules: NodeTemplateContextRule[]
): NodeTemplateContextPredicate => {
  return (ctx) => !ctx || !rules.some((rule) => matchRule(rule, ctx));
};

/**
 * 模板在给定上下文中是否可见：未声明谓词的模板为顶级节点，处处可见。
 */
export const isTemplateVisible = (
  template: Pick<FlowNodeTemplateType, 'isShowInContext'>,
  ctx: NodeTemplateContext | null
): boolean => {
  return !template.isShowInContext || template.isShowInContext(ctx);
};

/**
 * 校验节点连接的容器和模板上下文，供目标柄展示与 Runtime 连线提交共用。
 * context 由 Runtime 按来源节点派生（连线拖拽开始时算一次），目标柄只按 target 应用纯规则。
 */
export const isNodeConnectionAllowed = ({
  context,
  targetTemplate,
  targetNode,
  sourceParentNodeId
}: {
  /** 来源节点的 placement context；null 表示无法建立上下文，按「允许」处理。 */
  context: NodeTemplateContext | null;
  targetTemplate?: Pick<FlowNodeTemplateType, 'flowNodeType' | 'isShowInContext'>;
  targetNode: Pick<FlowNodeItemType, 'parentNodeId'>;
  sourceParentNodeId?: string;
}) => {
  if (sourceParentNodeId !== targetNode.parentNodeId) return false;
  if (!context || !targetTemplate) return true;

  if (
    getNodeContainerCheckError({
      node: targetTemplate,
      context
    })
  ) {
    return false;
  }

  return isTemplateVisible(targetTemplate, context);
};

export type NodeContainerCheckError =
  | 'can_not_loop'
  | 'can_not_parallel'
  | 'loop_run_break_must_inside_loop_run'
  | 'can_not_add_inside_container';

/** 使用显式分支保留翻译 key 的静态字面量引用，避免 i18n 清理脚本误删动态 key。 */
export const translateNodeContainerCheckError = (
  checkError: NodeContainerCheckError,
  t: (key: string) => string
) => {
  switch (checkError) {
    case 'can_not_loop':
      return t('workflow:can_not_loop');
    case 'can_not_parallel':
      return t('workflow:can_not_parallel');
    case 'loop_run_break_must_inside_loop_run':
      return t('workflow:loop_run_break_must_inside_loop_run');
    case 'can_not_add_inside_container':
      return t('workflow:can_not_add_inside_container');
  }
};

const UNSUPPORTED_IN_NESTED_NODE_TYPES = new Set<FlowNodeTypeEnum>([
  FlowNodeTypeEnum.workflowStart,
  FlowNodeTypeEnum.loop,
  FlowNodeTypeEnum.loopRun,
  FlowNodeTypeEnum.parallelRun,
  FlowNodeTypeEnum.pluginInput,
  FlowNodeTypeEnum.pluginOutput
]);

/** 统一校验节点是否可以加入目标容器，并返回对应的提示码。 */
export const getNodeContainerCheckError = ({
  node,
  context
}: {
  node: Pick<FlowNodeTemplateType, 'flowNodeType' | 'isShowInContext'>;
  context: NodeTemplateContext;
}): NodeContainerCheckError | undefined => {
  const parentType = context.parentType;

  if (
    node.flowNodeType === FlowNodeTypeEnum.loopRunBreak &&
    parentType !== FlowNodeTypeEnum.loopRun
  ) {
    return 'loop_run_break_must_inside_loop_run';
  }

  if (!parentType) return undefined;

  if (node.flowNodeType === FlowNodeTypeEnum.toolSet && !context.hasToolNode) {
    return 'can_not_add_inside_container';
  }

  if (isNestedParentNodeType(node.flowNodeType)) {
    return parentType === FlowNodeTypeEnum.parallelRun ? 'can_not_parallel' : 'can_not_loop';
  }

  if (parentType === FlowNodeTypeEnum.parallelRun && isInteractiveNodeType(node.flowNodeType)) {
    return 'can_not_parallel';
  }

  if (UNSUPPORTED_IN_NESTED_NODE_TYPES.has(node.flowNodeType)) {
    return parentType === FlowNodeTypeEnum.parallelRun ? 'can_not_parallel' : 'can_not_loop';
  }

  if (!isTemplateVisible(node, context)) return 'can_not_add_inside_container';

  return undefined;
};
