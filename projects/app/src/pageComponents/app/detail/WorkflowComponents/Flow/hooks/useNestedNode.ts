import { useEffect, useMemo, useRef } from 'react';
import { useContextSelector } from 'use-context-selector';
import {
  ArrayTypeMap,
  NodeInputKeyEnum,
  VARIABLE_NODE_ID,
  WorkflowIOValueTypeEnum
} from '@fastgpt/global/core/workflow/constants';
import { isValidArrayReferenceValue } from '@fastgpt/global/core/workflow/utils';
import { type ReferenceArrayValueType } from '@fastgpt/global/core/workflow/type/io';
import { type FlowNodeInputItemType } from '@fastgpt/global/core/workflow/type/io';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';
import { WorkflowBufferDataContext } from '../../context/workflowInitContext';
import { WorkflowActionsContext } from '../../context/workflowActionsContext';
import { getWorkflowGlobalVariables } from '@/web/core/workflow/utils';
import { AppContext } from '../../../context';

type UseNestedNodeParams = {
  nodeId: string;
  inputs: FlowNodeInputItemType[];
  // Pass `undefined` to skip array valueType inference (loopRun conditional mode).
  arrayInputKey?: NodeInputKeyEnum;
};

type UseNestedNodeResult = {
  nodeWidth: number;
  nodeHeight: number;
  inputBoxRef: React.RefObject<HTMLDivElement>;
};

// Shared hook for nested-container nodes (Loop / ParallelRun / LoopRun).
// [TODO] Move node size population to offscreen.
export const useNestedNode = ({
  nodeId,
  inputs,
  arrayInputKey = NodeInputKeyEnum.nestedInputArray
}: UseNestedNodeParams): UseNestedNodeResult => {
  const { getNodeById, nodeIds } = useContextSelector(WorkflowBufferDataContext, (v) => {
    return {
      getNodeById: v.getNodeById,
      nodeIds: v.nodeIds
    };
  });
  const onChangeNode = useContextSelector(WorkflowActionsContext, (v) => v.onChangeNode);
  const appDetail = useContextSelector(AppContext, (v) => v.appDetail);

  // ── 1. Read sizing & array input from inputs ────────────────────────────────
  const computedResult = useMemoEnhance(() => {
    return {
      nodeWidth: Math.round(
        Number(inputs.find((input) => input.key === NodeInputKeyEnum.nodeWidth)?.value) || 500
      ),
      nodeHeight: Math.round(
        Number(inputs.find((input) => input.key === NodeInputKeyEnum.nodeHeight)?.value) || 500
      ),
      nestedInputArray: arrayInputKey
        ? inputs.find((input) => input.key === arrayInputKey)
        : undefined
    };
  }, [inputs, arrayInputKey]);

  const nestedInputArray = useMemoEnhance(
    () => computedResult.nestedInputArray,
    [computedResult.nestedInputArray]
  );
  const nodeWidth = computedResult.nodeWidth;
  const nodeHeight = computedResult.nodeHeight;
  // ── 2. Infer array valueType from referenced output ─────────────────────────
  const newValueType = useMemo(() => {
    if (!nestedInputArray) return WorkflowIOValueTypeEnum.arrayAny;
    const value = nestedInputArray.value as ReferenceArrayValueType;

    if (!value || value.length === 0 || !isValidArrayReferenceValue(value, nodeIds)) {
      return WorkflowIOValueTypeEnum.arrayAny;
    }

    const globalVariables = getWorkflowGlobalVariables({
      chatConfig: appDetail.chatConfig
    });

    const valueType = ((ref) => {
      if (ref?.[0] === VARIABLE_NODE_ID) {
        return globalVariables.find((item) => item.key === ref[1])?.valueType;
      } else {
        const node = getNodeById(ref?.[0]);
        const output = node?.outputs.find((output) => output.id === ref?.[1]);
        return output?.valueType;
      }
    })(value[0]);

    return ArrayTypeMap[valueType as keyof typeof ArrayTypeMap] ?? WorkflowIOValueTypeEnum.arrayAny;
  }, [appDetail.chatConfig, getNodeById, nestedInputArray, nodeIds]);

  useEffect(() => {
    if (!nestedInputArray || !arrayInputKey || nestedInputArray.valueType === newValueType) return;
    onChangeNode({
      nodeId,
      type: 'updateInput',
      key: arrayInputKey,
      value: {
        ...nestedInputArray,
        valueType: newValueType
      }
    });
  }, [nestedInputArray, newValueType, nodeId, onChangeNode, arrayInputKey]);

  // ── 3. Measure input-box height locally ────────────────────────────────────
  // childrenNodeIdList 由 Runtime 在结构命令中维护；尺寸字段属于画布状态，
  // 不在节点挂载时回写文档，避免打开工作流凭空生成历史。
  const inputBoxRef = useRef<HTMLDivElement>(null);

  return { nodeWidth, nodeHeight, inputBoxRef };
};
