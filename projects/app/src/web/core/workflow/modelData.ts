import { getModelDetail, peekModelCatalog, peekModelDetail } from '@/web/core/ai/model/modelData';
import { getModelReferenceValue, isEmptyModelValue } from '@fastgpt/global/core/ai/modelReference';
import { workflowModelKeyMappings } from '@fastgpt/global/core/workflow/utils';
import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import { FlowNodeInputTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import type { AppChatConfigType } from '@fastgpt/global/core/app/type';

/** 收集工作流实际引用的模型查询项；异步与同步两条解析路径共用同一份引用识别规则。 */
const collectWorkflowModelReferences = (
  nodes: { data: FlowNodeItemType }[],
  chatConfig?: AppChatConfigType
) => {
  const references = new Map<string, { modelId?: string; model?: string }>();
  const add = (modelId: unknown, model: unknown) => {
    const value = getModelReferenceValue({ modelId, model });
    if (typeof value !== 'string' || isEmptyModelValue(value)) return;
    const reference = !isEmptyModelValue(modelId) ? { modelId: value } : { model: value };
    references.set(JSON.stringify(reference), reference);
  };
  /** Agent 内嵌知识库参数仍沿用相同键映射；不把任意文本或动态引用当成模型 ID。 */
  const inspectConfig = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(inspectConfig);
      return;
    }
    const config = value as Record<string, unknown>;
    for (const [legacyKey, modelIdKey] of workflowModelKeyMappings)
      add(config[modelIdKey], config[legacyKey]);
    add(config.modelId, config.model);
    Object.values(config).forEach(inspectConfig);
  };
  for (const { data } of nodes) {
    for (const [legacyKey, modelIdKey] of workflowModelKeyMappings) {
      const canonical = data.inputs.find((input) => input.key === modelIdKey);
      const legacy = data.inputs.find((input) => input.key === legacyKey);
      add(canonical?.value ?? canonical?.defaultValue, legacy?.value ?? legacy?.defaultValue);
    }
    for (const input of data.inputs) {
      if (input.renderTypeList.includes(FlowNodeInputTypeEnum.selectLLMModel)) {
        add(input.value ?? input.defaultValue, undefined);
      }
      inspectConfig(input.value);
    }
  }
  add(chatConfig?.questionGuide?.modelId, chatConfig?.questionGuide?.model);
  add(chatConfig?.ttsConfig?.modelId, chatConfig?.ttsConfig?.model);
  return [...references.values()];
};

/** 校验业务只读取实际引用的模型详情；共享 catalog 在 getter 内处理，不由 Context 预加载下发。 */
export const getWorkflowModelDetails = async (
  nodes: { data: FlowNodeItemType }[],
  chatConfig?: AppChatConfigType
) => {
  const models = await Promise.all(
    collectWorkflowModelReferences(nodes, chatConfig).map(getModelDetail)
  );
  return models.filter((model) => model !== undefined);
};

/**
 * 同步解析工作流引用的模型详情，供 Issue Provider 使用（provider 必须是同步调用）。
 * 目录未就绪返回 undefined，与“没有引用模型”的空数组区分开：调用方据此跳过本轮环境校验，
 * 目录就绪后由 host 触发一次 Issue 刷新补上结果。
 */
export const peekWorkflowModelDetails = (
  nodes: { data: FlowNodeItemType }[],
  chatConfig?: AppChatConfigType
) => {
  if (!peekModelCatalog()) return undefined;
  return collectWorkflowModelReferences(nodes, chatConfig)
    .map(peekModelDetail)
    .filter((model) => model !== undefined);
};
