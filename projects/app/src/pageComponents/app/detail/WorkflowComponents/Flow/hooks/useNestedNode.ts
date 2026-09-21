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
import { getWorkflowGlobalVariables } from '@/web/core/workflow/utils';
import { useNode } from '@/web/core/workflow/editor';
import { useWorkflowDocument } from '../nodes/render/useWorkflowDocument';
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
  // 跨节点读取（引用来源的输出类型）与节点 id 列表都走文档 reader：只在语义版本变化时重算。
  const { reader } = useWorkflowDocument();
  const node = useNode(nodeId);
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

    const nodeIds = (reader?.nodes ?? []).map((item) => item.nodeId);
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
        const sourceNode = reader?.getNodeById(ref?.[0]);
        const output = sourceNode?.outputs.find((output) => output.id === ref?.[1]);
        return output?.valueType;
      }
    })(value[0]);

    return ArrayTypeMap[valueType as keyof typeof ArrayTypeMap] ?? WorkflowIOValueTypeEnum.arrayAny;
  }, [appDetail.chatConfig, nestedInputArray, reader]);

  useEffect(() => {
    if (!nestedInputArray || !arrayInputKey || nestedInputArray.valueType === newValueType) return;
    // 记录级替换：基准取文档 inputs（不是 props 里过滤后的子集），只换命中 key 的那一条。
    const documentInputs = node?.data.inputs;
    if (!documentInputs) return;
    node?.updateNode({
      inputs: documentInputs.map((input) =>
        input.key === arrayInputKey ? { ...input, valueType: newValueType } : input
      )
    });
  }, [nestedInputArray, newValueType, node, arrayInputKey]);

  // ── 3. Measure input-box height locally ────────────────────────────────────
  // childrenNodeIdList 由 Runtime 在结构命令中维护；尺寸字段属于画布状态，
  // 不在节点挂载时回写文档，避免打开工作流凭空生成历史。
  const inputBoxRef = useRef<HTMLDivElement>(null);

  return { nodeWidth, nodeHeight, inputBoxRef };
};
