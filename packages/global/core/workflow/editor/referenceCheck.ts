import { VARIABLE_NODE_ID, WorkflowIOValueTypeEnum } from '../constants';
import type { ReferenceItemValueType, ReferenceValueType } from '../type/io';
import type { FlowNodeItemType } from '../type/node';
import type { AppChatConfigType } from '../../app/type';
import {
  filterSelectableWorkflowNodeOutputs,
  getWorkflowReferenceItems,
  isConfiguredReferenceValue,
  isWorkflowReferenceItem,
  type WorkflowReferenceSourceNode,
  workflowValueTypeIsCompatible
} from './utils';
import { getWorkflowGlobalVariables } from './variables';

export { getHTTPToolParamOutputs } from './utils';

export type WorkflowReferenceStatusCode =
  | 'empty'
  | 'valid'
  | 'invalid_reference'
  | 'unreachable_reference'
  | 'invalid_reference_type';

export type WorkflowReferenceStatus = {
  code: WorkflowReferenceStatusCode;
  sourceType?: WorkflowIOValueTypeEnum;
};

export type WorkflowReferenceIssueCode = Exclude<WorkflowReferenceStatusCode, 'empty' | 'valid'>;

type GetWorkflowReferenceStatusProps = {
  value: unknown;
  valueType?: WorkflowIOValueTypeEnum;
  sourceNodes?: WorkflowReferenceSourceNode[];
  getNodeById: (nodeId: string | null | undefined) => FlowNodeItemType | undefined;
  chatConfig?: AppChatConfigType;
};

const WORKFLOW_TEXT_REFERENCE_REGEXP = /\{\{\$([^$.]+)\.([^$]+)\$\}\}/g;

/** 递归提取 canonical 与文本引用；可关闭非 reference 字段中的 canonical tuple 解析。 */
export const getWorkflowReferenceItemsFromValue = (
  value: unknown,
  { includeCanonicalReferences = true }: { includeCanonicalReferences?: boolean } = {}
) => {
  const references: ReferenceItemValueType[] = [];
  const visited = new WeakSet<object>();

  const visit = (item: unknown) => {
    if (includeCanonicalReferences && isWorkflowReferenceItem(item)) {
      references.push(item);
      return;
    }

    if (typeof item === 'string') {
      for (const match of item.matchAll(WORKFLOW_TEXT_REFERENCE_REGEXP)) {
        references.push([match[1], match[2]]);
      }
      return;
    }

    if (!item || typeof item !== 'object' || visited.has(item)) return;
    visited.add(item);
    Object.values(item).forEach(visit);
  };

  visit(value);
  return [...new Map(references.map((reference) => [reference.join('\0'), reference])).values()];
};

const isMalformedReferenceValue = (value: unknown) => {
  if (!isConfiguredReferenceValue(value) || isWorkflowReferenceItem(value)) return false;
  if (!Array.isArray(value) || !value.some(Array.isArray)) return false;
  return value.some((item) => !isWorkflowReferenceItem(item));
};

/** 按引用 ID 查找来源节点和输出；sourceNodes 优先，未命中时回退到当前节点表。 */
export const getWorkflowReferenceSource = ({
  value,
  sourceNodes,
  getNodeById
}: {
  value: unknown;
  sourceNodes?: WorkflowReferenceSourceNode[];
  getNodeById?: (nodeId: string | null | undefined) => FlowNodeItemType | undefined;
}) => {
  if (!isWorkflowReferenceItem(value)) return {};

  const [sourceNodeId, outputId] = value;
  const sourceNode =
    sourceNodes?.find((node) => node.nodeId === sourceNodeId) ?? getNodeById?.(sourceNodeId);
  const sourceOutput = sourceNode?.outputs.find((output) => output.id === outputId);

  return {
    sourceNode,
    sourceOutput,
    sourceIcon: sourceNode
      ? 'name' in sourceNode
        ? sourceNode.avatar
        : sourceNode.icon
      : undefined,
    sourceLabel: sourceNode
      ? 'name' in sourceNode
        ? sourceNode.name
        : sourceNode.sourceLabel
      : undefined
  };
};

/**
 * 判断单项引用状态。输出可用性优先于来源范围，保证失效输出不会被误报为不可达。
 * 普通来源按 sourceNodes 判断范围；global reference 单独按 chatConfig 查询。
 */
export const getWorkflowReferenceStatus = ({
  value,
  valueType,
  sourceNodes,
  getNodeById,
  chatConfig
}: GetWorkflowReferenceStatusProps): WorkflowReferenceStatus => {
  if (!isConfiguredReferenceValue(value)) return { code: 'empty' };
  if (!isWorkflowReferenceItem(value)) return { code: 'invalid_reference' };

  const [sourceNodeId, outputId] = value;
  const source = getWorkflowReferenceSource({
    value,
    sourceNodes,
    getNodeById
  });

  if (sourceNodeId === VARIABLE_NODE_ID) {
    if (chatConfig !== undefined) {
      const globalVariable = getWorkflowGlobalVariables({ chatConfig }).find(
        (variable) => variable.key === outputId
      );
      if (!globalVariable) return { code: 'invalid_reference' };
      if (!workflowValueTypeIsCompatible(globalVariable.valueType, valueType)) {
        return {
          code: 'invalid_reference_type',
          sourceType: globalVariable.valueType
        };
      }
      return { code: 'valid', sourceType: globalVariable.valueType };
    }

    if (!source.sourceNode) return { code: 'valid' };
  }

  const { sourceNode, sourceOutput } = source;
  if (!sourceNode || !sourceOutput) return { code: 'invalid_reference' };

  const selectableOutput = filterSelectableWorkflowNodeOutputs({
    outputs: [sourceOutput],
    valueType: WorkflowIOValueTypeEnum.any,
    catchError: sourceNode.catchError
  });
  if (!selectableOutput.length) {
    return { code: 'invalid_reference', sourceType: sourceOutput.valueType };
  }

  if (
    sourceNodeId !== VARIABLE_NODE_ID &&
    sourceNodes &&
    !sourceNodes.some((node) => node.nodeId === sourceNodeId)
  ) {
    return { code: 'unreachable_reference', sourceType: sourceOutput.valueType };
  }

  if (!workflowValueTypeIsCompatible(sourceOutput.valueType, valueType)) {
    return { code: 'invalid_reference_type', sourceType: sourceOutput.valueType };
  }

  return { code: 'valid', sourceType: sourceOutput.valueType };
};

/** 将单选、多选和 malformed 值统一转换为引用状态，保留多选原顺序。 */
export const getWorkflowReferenceStatuses = ({
  value,
  ...props
}: GetWorkflowReferenceStatusProps): WorkflowReferenceStatus[] => {
  const referenceItems = getWorkflowReferenceItemsFromValue(value);
  const statuses = referenceItems.map((item) =>
    getWorkflowReferenceStatus({ value: item, ...props })
  );

  if (
    isMalformedReferenceValue(value) ||
    (statuses.length === 0 && isConfiguredReferenceValue(value))
  ) {
    return [{ code: 'invalid_reference' }, ...statuses];
  }

  return statuses;
};

/** 将多项引用状态聚合为一个稳定的 checker issue code。 */
export const getWorkflowReferenceIssueCode = (
  statuses: WorkflowReferenceStatus[]
): WorkflowReferenceIssueCode | undefined =>
  (['invalid_reference', 'unreachable_reference', 'invalid_reference_type'] as const).find((code) =>
    statuses.some((status) => status.code === code)
  );

/** 判断引用是否仍可被调试输入或 selector 接受；历史失效项不会成为新值。 */
export const workflowReferenceValueIsSelectable = ({
  value,
  sourceNodes,
  valueType,
  chatConfig
}: {
  value?: ReferenceValueType;
  sourceNodes: WorkflowReferenceSourceNode[];
  valueType?: WorkflowIOValueTypeEnum;
  chatConfig?: AppChatConfigType;
}) =>
  getWorkflowReferenceItems(value).some(
    (item) =>
      getWorkflowReferenceStatus({
        value: item,
        valueType,
        sourceNodes,
        getNodeById: () => undefined,
        chatConfig
      }).code === 'valid'
  );
