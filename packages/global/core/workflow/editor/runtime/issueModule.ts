import { NodeInputKeyEnum, NodeOutputKeyEnum, WorkflowIOValueTypeEnum } from '../../constants';
import { FlowNodeTypeEnum } from '../../node/constant';
import {
  canInputBeAgentGenerated,
  initToolInputTypeByDefaultMode,
  isAgentGeneratedToolInput
} from '../../../app/formEdit/utils';
import { nodeInputIsReference } from '../../utils';
import { isEmptyReferenceValue } from '../utils';
import type { FlowNodeInputItemType } from '../../type/io';
import type { WorkflowCheckIssue } from '../../type/node';
import type { WorkflowReferenceStatus } from '../types';
import { addFieldIdentity, isEmptyValue, isObject, valuesEqual } from './kernel';
import { getPlacementError } from './documentRules';
import type {
  DocumentReadApi,
  EdgeRecord,
  GraphIndex,
  MutationMeta,
  NodeRecord,
  ReferenceReadApi
} from './types';

/**
 * Issue module：拥有 issue 派生结果与可达节点集合。
 * 每笔事务只读一次最终的 Document/Reference/MutationMeta 状态，不写 Document。
 */

const noUpstreamExemptTypes = new Set<FlowNodeTypeEnum>([
  FlowNodeTypeEnum.workflowStart,
  FlowNodeTypeEnum.pluginInput,
  FlowNodeTypeEnum.nestedStart,
  FlowNodeTypeEnum.loopRunStart,
  FlowNodeTypeEnum.comment,
  FlowNodeTypeEnum.globalVariable,
  FlowNodeTypeEnum.emptyNode
]);

/** 检查已提交普通字段的基础值类型；引用字段由 Reference View 负责类型诊断。 */
const hasExpectedValueType = (value: unknown, valueType: WorkflowIOValueTypeEnum | undefined) => {
  if (!valueType || valueType === WorkflowIOValueTypeEnum.any) return true;
  if (
    valueType === WorkflowIOValueTypeEnum.chatHistory ||
    valueType === WorkflowIOValueTypeEnum.datasetQuote ||
    valueType === WorkflowIOValueTypeEnum.dynamic ||
    valueType === WorkflowIOValueTypeEnum.selectApp ||
    valueType === WorkflowIOValueTypeEnum.selectDataset
  ) {
    return true;
  }
  if (valueType === WorkflowIOValueTypeEnum.string) return typeof value === 'string';
  if (valueType === WorkflowIOValueTypeEnum.number)
    return typeof value === 'number' && Number.isFinite(value);
  if (valueType === WorkflowIOValueTypeEnum.boolean) return typeof value === 'boolean';
  if (valueType === WorkflowIOValueTypeEnum.object)
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (valueType.startsWith('array')) return Array.isArray(value);
  return true;
};

/** 将非正常引用状态转换为稳定的 Issue View 记录。 */
const issueForStatus = ({
  node,
  input,
  status
}: {
  node: NodeRecord;
  input: FlowNodeInputItemType;
  status: WorkflowReferenceStatus;
}): WorkflowCheckIssue | undefined => {
  if (status.code === 'valid' || status.code === 'empty') return undefined;
  const message =
    status.code === 'invalid_reference_type'
      ? `Input ${input.label} has an incompatible reference type`
      : status.code === 'unreachable_reference'
        ? `Input ${input.label} references an unreachable node`
        : `Input ${input.label} has an invalid reference`;
  return {
    nodeId: node.data.nodeId,
    nodeName: node.data.name,
    nodeType: node.data.flowNodeType,
    level: 'error',
    code: status.code,
    message,
    inputKey: input.key
  };
};

/**
 * 各节点类型的专属校验规则。入参全部来自 Document 只读数据，不依赖 Issue module 状态，
 * 因此可以放在 module 级别；返回值按顺序交给调用方去重后写入 Issue View。
 */
const collectNodeTypeIssues = ({
  node,
  nodes,
  graphIndex,
  isSourceEdgeValid
}: {
  node: NodeRecord;
  nodes: NodeRecord[];
  graphIndex: GraphIndex;
  isSourceEdgeValid: (edge: EdgeRecord) => boolean;
}) => {
  const issues: { code: string; message: string; inputKey?: string }[] = [];
  const addIssue = (code: string, message: string, inputKey?: string) => {
    issues.push({ code, message, ...(inputKey ? { inputKey } : {}) });
  };
  const inputs = node.data.inputs;
  const inputMap = new Map(inputs.map((input) => [input.key, input]));
  const getInputValue = (key: string) => {
    const input = inputMap.get(key);
    return input?.value ?? input?.defaultValue;
  };
  // 被工具选择边指向的节点算工具节点，代码节点的动态入参校验会放宽。
  const isToolNode = (graphIndex.byTarget.get(node.data.nodeId) ?? []).some(
    (edge) => edge.data.targetHandle === NodeOutputKeyEnum.selectedTools && isSourceEdgeValid(edge)
  );

  if (node.data.flowNodeType === FlowNodeTypeEnum.ifElseNode) {
    const ifElseList = getInputValue(NodeInputKeyEnum.ifElseList);
    const hasIncompleteCondition =
      !Array.isArray(ifElseList) ||
      ifElseList.some(
        (branch) =>
          !isObject(branch) ||
          !Array.isArray(branch.list) ||
          branch.list.some((condition) => {
            if (!isObject(condition)) return true;
            const hasEmptyVariable = isEmptyReferenceValue(condition.variable);
            const hasEmptyValue =
              condition.value === undefined ||
              (condition.valueType === 'reference' && isEmptyReferenceValue(condition.value));
            return (
              hasEmptyVariable ||
              condition.condition === undefined ||
              (hasEmptyValue &&
                condition.condition !== 'isEmpty' &&
                condition.condition !== 'isNotEmpty')
            );
          })
      );
    if (hasIncompleteCondition) {
      addIssue(
        'if_else_incomplete',
        'If/Else contains an incomplete condition',
        NodeInputKeyEnum.ifElseList
      );
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.userSelect) {
    const options = getInputValue(NodeInputKeyEnum.userSelectOptions);
    if (!Array.isArray(options) || options.length === 0) {
      addIssue(
        'user_select_empty',
        'User selection needs at least one option',
        NodeInputKeyEnum.userSelectOptions
      );
    } else if (options.some((option) => !isObject(option) || !option.value)) {
      addIssue(
        'user_select_value_empty',
        'User selection options cannot be empty',
        NodeInputKeyEnum.userSelectOptions
      );
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.formInput) {
    const forms = getInputValue(NodeInputKeyEnum.userInputForms);
    if (!Array.isArray(forms) || forms.length === 0) {
      addIssue(
        'form_input_empty',
        'Form input needs at least one field',
        NodeInputKeyEnum.userInputForms
      );
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.datasetConcatNode) {
    if (!inputs.some((input) => input.canEdit)) {
      addIssue(
        'required_input_empty',
        'Dataset concat needs at least one dataset quote',
        NodeInputKeyEnum.datasetQuoteList
      );
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.classifyQuestion) {
    const agents = getInputValue(NodeInputKeyEnum.agents);
    if (!Array.isArray(agents) || agents.length === 0) {
      addIssue(
        'classify_question_empty',
        'Classification needs at least one category',
        NodeInputKeyEnum.agents
      );
    } else if (agents.some((agent) => !isObject(agent) || !agent.value)) {
      addIssue(
        'classify_question_value_empty',
        'Classification values cannot be empty',
        NodeInputKeyEnum.agents
      );
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.code) {
    const hasIncompleteDynamicInput = inputs.some((input) => {
      if (
        [NodeInputKeyEnum.code, NodeInputKeyEnum.codeType, NodeInputKeyEnum.addInputParam].includes(
          input.key as NodeInputKeyEnum
        ) ||
        !input.canEdit
      ) {
        return false;
      }
      if (
        isToolNode &&
        isAgentGeneratedToolInput(
          initToolInputTypeByDefaultMode(input, { allowUserChatInputAgentGenerated: true })
        ) &&
        canInputBeAgentGenerated(input)
      ) {
        return false;
      }
      return !input.key || !input.label || isEmptyReferenceValue(input.value);
    });
    if (hasIncompleteDynamicInput) {
      addIssue('code_input_incomplete', 'Code input variables are incomplete');
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.httpRequest468) {
    if (isEmptyValue(getInputValue(NodeInputKeyEnum.httpReqUrl))) {
      addIssue('http_url_empty', 'HTTP request needs a URL', NodeInputKeyEnum.httpReqUrl);
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.contentExtract) {
    const extractKeys = getInputValue(NodeInputKeyEnum.extractKeys);
    if (!Array.isArray(extractKeys) || extractKeys.length === 0) {
      addIssue(
        'context_extract_empty',
        'Content extraction needs at least one target field',
        NodeInputKeyEnum.extractKeys
      );
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.loopRun) {
    if (getInputValue(NodeInputKeyEnum.loopRunMode) === 'conditional') {
      const childIds = getInputValue(NodeInputKeyEnum.childrenNodeIdList);
      const childIdSet = new Set(Array.isArray(childIds) ? childIds : []);
      const hasBreak = nodes.some(
        (child) =>
          childIdSet.has(child.data.nodeId) &&
          child.data.flowNodeType === FlowNodeTypeEnum.loopRunBreak
      );
      if (!hasBreak) {
        addIssue('loop_run_missing_break', 'Conditional loop needs a Loop Break node');
      }
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.toolCall) {
    const hasToolConnection = (graphIndex.bySource.get(node.data.nodeId) ?? []).some(
      (edge) =>
        edge.data.sourceHandle === NodeOutputKeyEnum.selectedTools && isSourceEdgeValid(edge)
    );
    if (!hasToolConnection && getInputValue(NodeInputKeyEnum.useAgentSandbox) !== true) {
      addIssue(
        'tool_call_empty',
        'Tool call needs a tool or the agent sandbox',
        NodeInputKeyEnum.useAgentSandbox
      );
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.variableUpdate) {
    const updateList = getInputValue(NodeInputKeyEnum.updateList);
    const isUpdateValueEmpty = (item: Record<string, unknown>) => {
      if (item.renderType === 'reference') return isEmptyReferenceValue(item.value);
      if (item.arrayMode === 'clear' || item.booleanMode) return false;
      const value = item.value;
      return (
        !Array.isArray(value) || value[1] === undefined || value[1] === null || value[1] === ''
      );
    };
    if (
      !Array.isArray(updateList) ||
      updateList.length === 0 ||
      updateList.some(
        (item) =>
          !isObject(item) || isEmptyReferenceValue(item.variable) || isUpdateValueEmpty(item)
      )
    ) {
      addIssue(
        'required_input_empty',
        'Variable update contains an incomplete item',
        NodeInputKeyEnum.updateList
      );
    }
  }

  return issues;
};

/** Create the Workflow Issue module. */
export const createIssueModule = ({
  document,
  reference
}: {
  document: DocumentReadApi;
  reference: ReferenceReadApi;
}) => {
  let issuesByNode = new Map<string, WorkflowCheckIssue[]>();
  let reachableNodeIds = new Set<string>();

  const getIssuesByNode = () => issuesByNode;
  const getNodeIssues = (nodeId: string) => issuesByNode.get(nodeId) ?? [];

  const calculateReachableNodeIds = () => {
    const graphIndex = document.getGraphIndex();
    const isSourceEdgeValid = document.isSourceEdgeValid;
    const nextReachableNodeIds = new Set<string>();
    const visitReachable = (nodeId: string) => {
      if (nextReachableNodeIds.has(nodeId)) return;
      nextReachableNodeIds.add(nodeId);
      (graphIndex.bySource.get(nodeId) ?? [])
        .filter(isSourceEdgeValid)
        .forEach((edge) => visitReachable(edge.data.target));
    };
    document.getDocument().nodes.forEach((node) => {
      if (
        node.data.flowNodeType === FlowNodeTypeEnum.workflowStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.pluginInput ||
        node.data.flowNodeType === FlowNodeTypeEnum.nestedStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.loopRunStart
      ) {
        visitReachable(node.data.nodeId);
      }
    });
    return nextReachableNodeIds;
  };

  /** 结构变更只刷新受影响的可达性闭包；未触碰节点继续复用旧结果。 */
  const updateReachableNodeIds = (affectedNodeIds: ReadonlySet<string>) => {
    if (affectedNodeIds.size === 0) return;
    const graphIndex = document.getGraphIndex();
    const isSourceEdgeValid = document.isSourceEdgeValid;
    const nextReachableNodeIds = new Set(reachableNodeIds);
    affectedNodeIds.forEach((nodeId) => nextReachableNodeIds.delete(nodeId));
    const queue: string[] = [];
    const queued = new Set<string>();
    const enqueue = (nodeId: string) => {
      if (!affectedNodeIds.has(nodeId) || queued.has(nodeId)) return;
      queued.add(nodeId);
      queue.push(nodeId);
    };

    document.getDocument().nodes.forEach((node) => {
      const nodeId = node.data.nodeId;
      const isStart =
        node.data.flowNodeType === FlowNodeTypeEnum.workflowStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.pluginInput ||
        node.data.flowNodeType === FlowNodeTypeEnum.nestedStart ||
        node.data.flowNodeType === FlowNodeTypeEnum.loopRunStart;
      if (isStart) enqueue(nodeId);
      if (!affectedNodeIds.has(nodeId)) return;
      const hasReachableOutsideSource = (graphIndex.byTarget.get(nodeId) ?? []).some(
        (edge) =>
          !affectedNodeIds.has(edge.data.source) &&
          nextReachableNodeIds.has(edge.data.source) &&
          isSourceEdgeValid(edge)
      );
      if (hasReachableOutsideSource) enqueue(nodeId);
    });

    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const nodeId = queue[queueIndex++];
      nextReachableNodeIds.add(nodeId);
      (graphIndex.bySource.get(nodeId) ?? [])
        .filter(isSourceEdgeValid)
        .forEach((edge) => enqueue(edge.data.target));
    }
    reachableNodeIds = nextReachableNodeIds;
  };

  /** 根据当前 Document 更新 Issue View；局部事务只重算受影响节点。 */
  const rebuildIssues = (onlyNodeIds?: ReadonlySet<string>) => {
    const current = document.getDocument();
    const graphIndex = document.getGraphIndex();
    const isSourceEdgeValid = document.isSourceEdgeValid;
    const nextIssues = onlyNodeIds
      ? new Map(issuesByNode)
      : new Map<string, WorkflowCheckIssue[]>();
    if (!onlyNodeIds) reachableNodeIds = calculateReachableNodeIds();

    current.nodes
      .filter((node) => !onlyNodeIds || onlyNodeIds.has(node.data.nodeId))
      .forEach((node) => {
        const issues: WorkflowCheckIssue[] = [];
        const addIssue = (code: string, message: string, inputKey?: string) => {
          if (issues.some((issue) => issue.code === code && issue.inputKey === inputKey)) return;
          issues.push({
            nodeId: node.data.nodeId,
            nodeName: node.data.name,
            nodeType: node.data.flowNodeType,
            level: 'error',
            code,
            message,
            ...(inputKey ? { inputKey } : {})
          });
        };

        node.data.inputs.forEach((input) => {
          const value = input.value ?? input.defaultValue;
          if (input.required && isEmptyValue(value)) {
            addIssue('required', `Input ${input.label} is required`, input.key);
          } else if (
            !isEmptyValue(value) &&
            !nodeInputIsReference(input) &&
            !hasExpectedValueType(value, input.valueType)
          ) {
            addIssue('invalid_type', `Input ${input.label} has an invalid value type`, input.key);
          }
          reference.getFieldStatuses(node.data.nodeId, input).forEach((status) => {
            const issue = issueForStatus({ node, input, status });
            if (issue) addIssue(issue.code, issue.message, issue.inputKey);
          });
        });

        collectNodeTypeIssues({
          node,
          nodes: current.nodes,
          graphIndex,
          isSourceEdgeValid
        }).forEach(({ code, message, inputKey }) => addIssue(code, message, inputKey));

        if (getPlacementError({ working: current, node, parentId: node.data.parentNodeId })) {
          addIssue('invalid_placement', 'Node placement is not allowed');
        }

        const incoming = (graphIndex.byTarget.get(node.data.nodeId) ?? []).some((edge) =>
          isSourceEdgeValid(edge)
        );
        if (!incoming && !noUpstreamExemptTypes.has(node.data.flowNodeType)) {
          issues.push({
            nodeId: node.data.nodeId,
            nodeName: node.data.name,
            nodeType: node.data.flowNodeType,
            level: 'warning',
            code: 'no_upstream',
            message: 'Node is not connected to an upstream node'
          });
        } else if (
          incoming &&
          reachableNodeIds.size > 0 &&
          !reachableNodeIds.has(node.data.nodeId) &&
          !noUpstreamExemptTypes.has(node.data.flowNodeType)
        ) {
          addIssue('unreachable_from_start', 'Node cannot be reached from a workflow start node');
        }
        const previous = issuesByNode.get(node.data.nodeId);
        nextIssues.set(
          node.data.nodeId,
          previous && valuesEqual(previous, issues) ? previous : issues
        );
      });
    onlyNodeIds?.forEach((nodeId) => {
      if (!document.getNodeById(nodeId)) nextIssues.delete(nodeId);
    });
    issuesByNode = nextIssues;
  };

  /** Issue View 是同步派生结果；只把实际变更的节点加入 affected records。 */
  const addChangedIssueRecords = (
    meta: MutationMeta,
    previous: Map<string, WorkflowCheckIssue[]>,
    candidateNodeIds: ReadonlySet<string>
  ) => {
    candidateNodeIds.forEach((nodeId) => {
      if (valuesEqual(previous.get(nodeId) ?? [], issuesByNode.get(nodeId) ?? [])) return;
      meta.affectedNodeIds.add(nodeId);
      [...(previous.get(nodeId) ?? []), ...(issuesByNode.get(nodeId) ?? [])].forEach((issue) => {
        if (!issue.inputKey) return;
        addFieldIdentity(meta.affectedFieldIds, {
          nodeId,
          key: issue.inputKey,
          kind: 'input'
        });
      });
    });
  };

  /**
   * 收集本笔事务需要重算 issue 的候选节点。必须在引用/结构派生之前调用：
   * 候选集合顺序 affected 先、changed 后，决定 issues 数组与 affected records 的排列，
   * 派生结束后由 rebuildForTransaction 并入新增的 affected 节点。
   */
  const collectTransactionNodeIds = (meta: MutationMeta): Set<string> => {
    const nodeIds = new Set(meta.affectedNodeIds);
    meta.changedNodeIds.forEach((nodeId) => nodeIds.add(nodeId));
    return nodeIds;
  };

  /**
   * 派生结束后重算 Issue View：并入新增 affected 节点，按结构变化刷新可达集合，
   * 再把实际发生变化的 issue 写回 affected records。
   * 调用前必须已丢弃过期字段状态缓存，否则会用旧引用状态判定 issue。
   */
  const rebuildForTransaction = ({
    meta,
    candidateNodeIds
  }: {
    meta: MutationMeta;
    candidateNodeIds: Set<string>;
  }) => {
    const previousIssues = issuesByNode;
    meta.affectedNodeIds.forEach((nodeId) => candidateNodeIds.add(nodeId));
    if (meta.structureChanged) updateReachableNodeIds(meta.affectedNodeIds);
    rebuildIssues(candidateNodeIds);
    addChangedIssueRecords(meta, previousIssues, candidateNodeIds);
  };

  const clear = () => {
    issuesByNode = new Map();
    reachableNodeIds = new Set();
  };

  return {
    getIssuesByNode,
    getNodeIssues,
    rebuildIssues,
    addChangedIssueRecords,
    collectTransactionNodeIds,
    rebuildForTransaction,
    clear
  };
};
