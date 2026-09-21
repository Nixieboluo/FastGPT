import React, { useCallback } from 'react';
import type { RenderInputProps } from '../type';
import type { SettingAIDataType } from '@fastgpt/global/core/app/type';
import SettingLLMModel from '@/components/core/ai/SettingLLMModel';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { useNode } from '@/web/core/workflow/editor';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';
import { useLocalStorageState } from 'ahooks';
import { Input_Template_SettingAiModel } from '@fastgpt/global/core/workflow/template/input';

/**
 * 模型配置模板：一次表单提交可能同时改多个字段（模型、上限、温度等），
 * 因此按记录级变更处理——读文档当前 inputs、合并全部改动后一次 updateNode 提交，
 * 保证一次交互只产生一条可撤销历史。
 */
const SelectAiModelRender = ({ inputs = [], nodeId, settingLLMModelProps }: RenderInputProps) => {
  const node = useNode(nodeId);
  const [, setDefaultModel] = useLocalStorageState<string>('workflow_default_llm_model', {
    defaultValue: ''
  });

  const onChangeModel = useCallback(
    (e: SettingAIDataType) => {
      const documentInputs = node?.data.inputs;
      if (!documentInputs) return;

      const nextInputs = [...documentInputs];
      const setValueByKey = (key: string, value: unknown) => {
        const index = nextInputs.findIndex((input) => input.key === key);
        if (index >= 0) nextInputs[index] = { ...nextInputs[index], value };
      };

      for (const key in e) {
        const value = e[key as keyof SettingAIDataType];

        if (key !== NodeInputKeyEnum.aiModelId) {
          setValueByKey(key, value);
          continue;
        }

        // aiModelId 声明为 string；顺带挡掉 undefined，避免写坏本地默认模型缓存。
        if (typeof value !== 'string') continue;
        setDefaultModel(value);
        const legacyIndex = nextInputs.findIndex((input) => input.key === NodeInputKeyEnum.aiModel);
        const modelIdIndex = nextInputs.findIndex(
          (input) => input.key === NodeInputKeyEnum.aiModelId
        );
        if (modelIdIndex >= 0) {
          nextInputs[modelIdIndex] = { ...nextInputs[modelIdIndex], value };
          // 迁移后同时存在旧字段时删除，避免两份模型值。
          if (legacyIndex >= 0) nextInputs.splice(legacyIndex, 1);
        } else if (legacyIndex >= 0) {
          // 旧 aiModel 记录原地改名为 aiModelId，保留其余元数据。
          nextInputs[legacyIndex] = {
            ...nextInputs[legacyIndex],
            key: NodeInputKeyEnum.aiModelId,
            value
          };
        } else {
          nextInputs.push({ ...Input_Template_SettingAiModel, value });
        }
      }

      node?.updateNode({ inputs: nextInputs });
    },
    [node, setDefaultModel]
  );

  const model = useMemoEnhance(() => {
    const aiModelInput =
      inputs.find((input) => input.key === NodeInputKeyEnum.aiModelId) ||
      inputs.find((input) => input.key === NodeInputKeyEnum.aiModel);
    return aiModelInput?.value as string | undefined;
  }, [inputs]);

  const llmModelData: SettingAIDataType = useMemoEnhance(
    () => ({
      modelId: model,
      maxToken: inputs.find((input) => input.key === NodeInputKeyEnum.aiChatMaxToken)?.value,
      temperature: inputs.find((input) => input.key === NodeInputKeyEnum.aiChatTemperature)?.value,
      isResponseAnswerText: inputs.find(
        (input) => input.key === NodeInputKeyEnum.aiChatIsResponseText
      )?.value,
      aiChatVision:
        inputs.find((input) => input.key === NodeInputKeyEnum.aiChatVision)?.value ?? true,
      aiChatAudio:
        inputs.find((input) => input.key === NodeInputKeyEnum.aiChatAudio)?.value ?? false,
      aiChatVideo:
        inputs.find((input) => input.key === NodeInputKeyEnum.aiChatVideo)?.value ?? false,
      aiChatExtractFiles:
        inputs.find((input) => input.key === NodeInputKeyEnum.aiChatExtractFiles)?.value ?? true,
      aiChatReasoning:
        inputs.find((input) => input.key === NodeInputKeyEnum.aiChatReasoning)?.value ?? true,
      aiChatReasoningEffort: inputs.find(
        (input) => input.key === NodeInputKeyEnum.aiChatReasoningEffort
      )?.value,
      aiChatTopP: inputs.find((input) => input.key === NodeInputKeyEnum.aiChatTopP)?.value,
      aiChatStopSign: inputs.find((input) => input.key === NodeInputKeyEnum.aiChatStopSign)?.value,
      aiChatResponseFormat: inputs.find(
        (input) => input.key === NodeInputKeyEnum.aiChatResponseFormat
      )?.value,
      aiChatJsonSchema: inputs.find((input) => input.key === NodeInputKeyEnum.aiChatJsonSchema)
        ?.value
    }),
    [inputs, model]
  );

  return (
    <SettingLLMModel
      defaultData={llmModelData}
      onChange={onChangeModel}
      {...settingLLMModelProps}
    />
  );
};

export default React.memo(SelectAiModelRender);
