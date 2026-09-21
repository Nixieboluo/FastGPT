import React, { useCallback, useMemo } from 'react';
import type { RenderInputProps } from '../type';
import { useContextSelector } from 'use-context-selector';
import { NodeInputKeyEnum, WorkflowIOValueTypeEnum } from '@fastgpt/global/core/workflow/constants';
import {
  createEmptyTagFilterValue,
  isDatasetTagFilterValue,
  normalizeLegacyDatasetTagFilterValue,
  type DatasetTagFilterValue
} from '@fastgpt/global/core/dataset/workflowTagFilter';
import { useReference } from './Reference';
import DatasetTagFilterRows, {
  DatasetTagFilterDeprecated,
  DatasetTagFilterUpgradeButton,
  TagFilterLogicToggle
} from '@/components/core/dataset/DatasetTagFilterRows';
import { AppContext } from '@/pageComponents/app/detail/context';
import { getEditorVariables } from '@/pageComponents/app/detail/WorkflowComponents/utils';
import { useSystemStore } from '@/web/common/system/useSystemStore';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';
import { useTranslation } from 'next-i18next';
import { FlowNodeInputTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import { DatasetSearchModule } from '@fastgpt/global/core/workflow/template/system/datasetSearch';
import { useField, useNode } from '@/web/core/workflow/editor';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';
import { useWorkflowDocument } from '../../useWorkflowDocument';
import {
  datasetSearchUsesLegacyFilter,
  persistLegacyDatasetSearchNodeUpgrade
} from '@/web/core/workflow/datasetSearchNodeUpgrade';

const DatasetTagFilterRender = ({ inputs = [], item, nodeId }: RenderInputProps) => {
  const { t } = useTranslation();
  const field = useField(nodeId, item.key, 'input');
  const { reader } = useWorkflowDocument();
  const { appDetail } = useContextSelector(AppContext, (v) => v);
  const { feConfigs } = useSystemStore();
  const isLegacyNode = datasetSearchUsesLegacyFilter(inputs);

  const { referenceList } = useReference({
    nodeId,
    valueType: WorkflowIOValueTypeEnum.any
  });
  const datasetIds = useMemo(() => {
    const datasetValue = inputs.find(
      (input) => input.key === NodeInputKeyEnum.datasetSelectList
    )?.value;
    if (!Array.isArray(datasetValue)) return [];
    return datasetValue
      .map((dataset) =>
        dataset && typeof dataset === 'object' && 'datasetId' in dataset
          ? String(dataset.datasetId ?? '')
          : ''
      )
      .filter(Boolean);
  }, [inputs]);

  const editorVariables = useMemoEnhance(() => {
    if (!reader) return [];
    return getEditorVariables({
      nodeId,
      getNodeById: reader.getNodeById,
      edges: reader.edges,
      appDetail,
      t
    });
  }, [nodeId, reader, appDetail, t]);

  const externalVariables = useMemo(() => {
    return (
      feConfigs?.externalProviderWorkflowVariables?.map((item) => ({
        key: item.key,
        label: item.name
      })) ?? []
    );
  }, [feConfigs?.externalProviderWorkflowVariables]);

  const allVariables = useMemo(
    () => [...(editorVariables ?? []), ...externalVariables],
    [editorVariables, externalVariables]
  );

  const onChange = useCallback(
    (value: DatasetTagFilterValue | string) => {
      field?.setValue(value);
    },
    [field]
  );

  if (isLegacyNode) {
    return (
      <DatasetTagFilterDeprecated
        value={normalizeLegacyDatasetTagFilterValue(item.value)}
        onChange={onChange}
        variables={allVariables}
        variableLabels={editorVariables}
      />
    );
  }

  return (
    <DatasetTagFilterRows
      value={item.value}
      onChange={onChange}
      datasetIds={datasetIds}
      referenceList={referenceList}
    />
  );
};

/** 标题右侧组件：新版显示 AND/OR 切换；旧版显示「已弃用，升级到最新版本」 */
export const DatasetTagFilterLogic = React.memo(function DatasetTagFilterLogic({
  inputs = [],
  item,
  nodeId
}: RenderInputProps) {
  const field = useField(nodeId, item.key, 'input');
  const node = useNode(nodeId);
  /** 升级要先持久化整份工作流，出站序列化直接读 host。 */
  const serializeWorkflow = useContextSelector(WorkflowHostContext, (v) => v.serializeWorkflow);
  const { appDetail, onSaveApp } = useContextSelector(AppContext, (v) => v);
  const isLegacyNode = datasetSearchUsesLegacyFilter(inputs);

  if (isLegacyNode) {
    return (
      <DatasetTagFilterUpgradeButton
        onUpgrade={async () => {
          const upgradedInput = {
            ...item,
            renderTypeList: [
              FlowNodeInputTypeEnum.datasetTagFilter,
              FlowNodeInputTypeEnum.reference
            ],
            selectedType: FlowNodeInputTypeEnum.datasetTagFilter,
            label:
              DatasetSearchModule.inputs.find((input) => input.key === item.key)?.label ??
              item.label,
            description:
              DatasetSearchModule.inputs.find((input) => input.key === item.key)?.description ??
              item.description,
            value: createEmptyTagFilterValue()
          };
          const workflow = serializeWorkflow();
          if (!workflow) throw new Error('Workflow data is unavailable');
          await persistLegacyDatasetSearchNodeUpgrade({
            nodes: workflow.nodes,
            nodeId,
            filterInput: upgradedInput,
            persist: (nodes) =>
              onSaveApp({
                ...workflow,
                nodes,
                isPublish: false,
                chatConfig: appDetail.chatConfig
              }),
            commit: (upgradedNode) =>
              // 持久化成功后再把升级结果写回文档：整份 inputs 替换，一次提交。
              node?.updateNode({ inputs: upgradedNode.inputs })
          });
        }}
      />
    );
  }

  return (
    <TagFilterLogicToggle
      value={isDatasetTagFilterValue(item.value) ? item.value : createEmptyTagFilterValue()}
      onChange={(value) => {
        field?.setValue(value);
      }}
    />
  );
});

export default React.memo(DatasetTagFilterRender);
