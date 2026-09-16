import { isToolParamInput } from '../../app/formEdit/utils';
import { NodeInputKeyEnum, NodeOutputKeyEnum, WorkflowIOValueTypeEnum } from '../constants';
import { FlowNodeOutputTypeEnum, FlowNodeTypeEnum } from '../node/constant';
import { getHandleId, nodeInputIsReference } from '../utils';
import type {
  FlowNodeInputItemType,
  FlowNodeOutputItemType,
  ReferenceItemValueType
} from '../type/io';
import type { FlowNodeItemType } from '../type/node';

const workflowValueTypeCompatMap: Record<WorkflowIOValueTypeEnum, WorkflowIOValueTypeEnum[]> = {
  [WorkflowIOValueTypeEnum.string]: [WorkflowIOValueTypeEnum.string],
  [WorkflowIOValueTypeEnum.number]: [WorkflowIOValueTypeEnum.number],
  [WorkflowIOValueTypeEnum.boolean]: [WorkflowIOValueTypeEnum.boolean],
  [WorkflowIOValueTypeEnum.object]: [WorkflowIOValueTypeEnum.object],
  [WorkflowIOValueTypeEnum.arrayString]: [
    WorkflowIOValueTypeEnum.string,
    WorkflowIOValueTypeEnum.arrayString,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.arrayNumber]: [
    WorkflowIOValueTypeEnum.number,
    WorkflowIOValueTypeEnum.arrayNumber,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.arrayBoolean]: [
    WorkflowIOValueTypeEnum.boolean,
    WorkflowIOValueTypeEnum.arrayBoolean,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.arrayObject]: [
    WorkflowIOValueTypeEnum.object,
    WorkflowIOValueTypeEnum.arrayObject,
    WorkflowIOValueTypeEnum.arrayAny,
    WorkflowIOValueTypeEnum.chatHistory,
    WorkflowIOValueTypeEnum.datasetQuote,
    WorkflowIOValueTypeEnum.dynamic,
    WorkflowIOValueTypeEnum.selectDataset,
    WorkflowIOValueTypeEnum.selectApp
  ],
  [WorkflowIOValueTypeEnum.chatHistory]: [
    WorkflowIOValueTypeEnum.chatHistory,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.datasetQuote]: [
    WorkflowIOValueTypeEnum.datasetQuote,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.dynamic]: [
    WorkflowIOValueTypeEnum.dynamic,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.selectDataset]: [
    WorkflowIOValueTypeEnum.selectDataset,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.selectApp]: [
    WorkflowIOValueTypeEnum.selectApp,
    WorkflowIOValueTypeEnum.arrayAny
  ],
  [WorkflowIOValueTypeEnum.arrayAny]: [WorkflowIOValueTypeEnum.arrayAny],
  [WorkflowIOValueTypeEnum.any]: [WorkflowIOValueTypeEnum.arrayAny]
};

/** 判断来源类型能否赋值给目标类型；与引用选择器和工作流检查共用。 */
export const workflowValueTypeIsCompatible = (
  sourceType: WorkflowIOValueTypeEnum | undefined,
  targetType: WorkflowIOValueTypeEnum | undefined
): boolean =>
  !targetType ||
  targetType === WorkflowIOValueTypeEnum.any ||
  targetType === WorkflowIOValueTypeEnum.arrayAny ||
  !sourceType ||
  sourceType === WorkflowIOValueTypeEnum.any ||
  workflowValueTypeCompatMap[targetType]?.includes(sourceType) === true;

export const filterWorkflowNodeOutputsByType = (
  outputs: FlowNodeOutputItemType[],
  valueType: WorkflowIOValueTypeEnum
): FlowNodeOutputItemType[] =>
  outputs.filter((output) => workflowValueTypeIsCompatible(output.valueType, valueType));

export type WorkflowReferenceSourceNode = {
  nodeId: string;
  sourceLabel?: string;
  icon?: string;
  outputs: FlowNodeOutputItemType[];
  catchError?: boolean;
};

/** 多分支节点只允许当前仍存在的 source handle 参与来源计算。 */
export const isWorkflowEdgeSourceHandleValid = (
  sourceNode: FlowNodeItemType | undefined,
  sourceHandle: string | null | undefined
) => {
  if (!sourceNode) return false;

  const { nodeId, flowNodeType, inputs } = sourceNode;
  if (flowNodeType === FlowNodeTypeEnum.userSelect) {
    if (!sourceHandle) return false;
    const options = inputs?.find((input) => input.key === NodeInputKeyEnum.userSelectOptions)
      ?.value as Array<{ key?: string }> | undefined;
    return (
      Array.isArray(options) &&
      options.some(
        (option) => option.key && sourceHandle === getHandleId(nodeId, 'source', option.key)
      )
    );
  }

  if (flowNodeType === FlowNodeTypeEnum.classifyQuestion) {
    if (!sourceHandle) return false;
    const agents = inputs?.find((input) => input.key === NodeInputKeyEnum.agents)?.value as
      | Array<{ key?: string }>
      | undefined;
    return (
      Array.isArray(agents) &&
      agents.some((agent) => agent.key && sourceHandle === getHandleId(nodeId, 'source', agent.key))
    );
  }

  return true;
};

/** 过滤引用选择器和 Runtime 可见的输出。 */
export const filterSelectableWorkflowNodeOutputs = ({
  outputs,
  valueType,
  catchError
}: {
  outputs: FlowNodeOutputItemType[];
  valueType?: WorkflowIOValueTypeEnum;
  catchError?: boolean;
}) => {
  const selectableOutputs = outputs.filter((output) => {
    if (output.id === NodeOutputKeyEnum.addOutputParam || output.invalid === true) return false;
    if (output.type === FlowNodeOutputTypeEnum.error) return catchError === true;
    return true;
  });

  return filterWorkflowNodeOutputsByType(
    selectableOutputs,
    valueType ?? WorkflowIOValueTypeEnum.any
  );
};

export const isWorkflowReferenceItem = (value: unknown): value is ReferenceItemValueType =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'string' &&
  typeof value[1] === 'string' &&
  value[0].length > 0 &&
  value[1].length > 0;

/** 从单选或多选值中按原顺序提取 canonical 引用。 */
export const getWorkflowReferenceItems = (value: unknown): ReferenceItemValueType[] => {
  if (isWorkflowReferenceItem(value)) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter(isWorkflowReferenceItem);
};

export const isEmptyReferenceValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) &&
    (value.length === 0 ||
      (value.length === 2 &&
        ((value[0] === '' && value[1] === '') ||
          (value[0] === undefined && value[1] === undefined)))));

export const isConfiguredReferenceValue = (value: unknown) => !isEmptyReferenceValue(value);

/** HTTP 工具节点的动态参数作为可引用输出。 */
export const getHTTPToolParamOutputs = (node: FlowNodeItemType) =>
  node.flowNodeType === FlowNodeTypeEnum.httpRequest468
    ? node.inputs.filter(isToolParamInput).map((input) => ({
        id: input.key,
        key: input.key,
        type: FlowNodeOutputTypeEnum.static,
        label: input.label ?? input.key,
        valueType: input.valueType
      }))
    : [];
