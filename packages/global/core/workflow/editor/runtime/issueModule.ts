import { NodeInputKeyEnum, NodeOutputKeyEnum } from '../../constants';
import { FlowNodeTypeEnum } from '../../node/constant';
import {
  canInputBeAgentGenerated,
  initToolInputTypeByDefaultMode,
  isAgentGeneratedToolInput
} from '../../../app/formEdit/utils';
import { isEmptyReferenceValue } from '../utils';
import type { FlowNodeInputItemType } from '../../type/io';
import type { WorkflowCheckIssue } from '../../type/node';
import type { WorkflowIssueCode } from '../issueCode';
import type {
  WorkflowConfigIssue,
  WorkflowIssueProvider,
  WorkflowIssueScope,
  WorkflowReferenceStatus,
  WorkflowSnapshot
} from '../types';
import { addFieldIdentity, isEmptyValue, isObject, valuesEqual } from './kernel';
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
  return {
    nodeId: node.data.nodeId,
    level: 'error',
    code: status.code,
    inputKey: input.key,
    params: { inputName: input.label ?? input.key }
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
  const issues: { code: WorkflowIssueCode; inputKey?: string }[] = [];
  const addIssue = (code: WorkflowIssueCode, inputKey?: string) => {
    issues.push({ code, ...(inputKey ? { inputKey } : {}) });
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
      addIssue('if_else_incomplete', NodeInputKeyEnum.ifElseList);
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.userSelect) {
    const options = getInputValue(NodeInputKeyEnum.userSelectOptions);
    if (!Array.isArray(options) || options.length === 0) {
      addIssue('user_select_empty', NodeInputKeyEnum.userSelectOptions);
    } else if (options.some((option) => !isObject(option) || !option.value)) {
      addIssue('user_select_value_empty', NodeInputKeyEnum.userSelectOptions);
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.formInput) {
    const forms = getInputValue(NodeInputKeyEnum.userInputForms);
    if (!Array.isArray(forms) || forms.length === 0) {
      addIssue('form_input_empty', NodeInputKeyEnum.userInputForms);
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.datasetConcatNode) {
    if (!inputs.some((input) => input.canEdit)) {
      addIssue('required_input_empty', NodeInputKeyEnum.datasetQuoteList);
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.classifyQuestion) {
    const agents = getInputValue(NodeInputKeyEnum.agents);
    if (!Array.isArray(agents) || agents.length === 0) {
      addIssue('classify_question_empty', NodeInputKeyEnum.agents);
    } else if (agents.some((agent) => !isObject(agent) || !agent.value)) {
      addIssue('classify_question_value_empty', NodeInputKeyEnum.agents);
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
      addIssue('code_input_incomplete');
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.httpRequest468) {
    if (isEmptyValue(getInputValue(NodeInputKeyEnum.httpReqUrl))) {
      addIssue('http_url_empty', NodeInputKeyEnum.httpReqUrl);
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.contentExtract) {
    const extractKeys = getInputValue(NodeInputKeyEnum.extractKeys);
    if (!Array.isArray(extractKeys) || extractKeys.length === 0) {
      addIssue('context_extract_empty', NodeInputKeyEnum.extractKeys);
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
        addIssue('loop_run_missing_break');
      }
    }
  }

  if (node.data.flowNodeType === FlowNodeTypeEnum.toolCall) {
    const hasToolConnection = (graphIndex.bySource.get(node.data.nodeId) ?? []).some(
      (edge) =>
        edge.data.sourceHandle === NodeOutputKeyEnum.selectedTools && isSourceEdgeValid(edge)
    );
    if (!hasToolConnection && getInputValue(NodeInputKeyEnum.useAgentSandbox) !== true) {
      addIssue('tool_call_empty', NodeInputKeyEnum.useAgentSandbox);
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
      addIssue('required_input_empty', NodeInputKeyEnum.updateList);
    }
  }

  return issues;
};

/** Issue 去重身份：同一节点上 code 与 field identity 相同即视为同一条问题。 */
const getIssueIdentity = (issue: WorkflowCheckIssue) => `${issue.code}\0${issue.inputKey ?? ''}`;

/** Create the Workflow Issue module. */
export const createIssueModule = ({
  document,
  reference,
  issueProvider
}: {
  document: DocumentReadApi;
  reference: ReferenceReadApi;
  /** editor 注入的同步 Issue Provider；缺省时 Unified Issue View 只有文档确定性结果。 */
  issueProvider?: WorkflowIssueProvider;
}) => {
  /** 文档确定性检查结果；由 rebuildIssues 全量或按候选节点重算。 */
  let documentIssuesByNode = new Map<string, WorkflowCheckIssue[]>();
  /** provider 结果分桶：刷新时按 scope 整桶替换，不混写文档检查结果。 */
  let providerIssuesByNode = new Map<string, WorkflowCheckIssue[]>();
  /** Unified Issue View：两个来源合并后的唯一读取面，对外只暴露这一份。 */
  let issuesByNode = new Map<string, WorkflowCheckIssue[]>();
  /** 工作流级问题桶：chatConfig 的模型问题不属于任何节点。 */
  let configIssues: WorkflowConfigIssue[] = [];
  let reachableNodeIds = new Set<string>();

  const getIssuesByNode = () => issuesByNode;
  const getNodeIssues = (nodeId: string) => issuesByNode.get(nodeId) ?? [];
  const getConfigIssues = () => configIssues;

  /** 文档检查是权威结果；provider 与文档同 code + field identity 的条目直接丢弃。 */
  const mergeIssues = (
    documentIssues: WorkflowCheckIssue[],
    providerIssues: WorkflowCheckIssue[]
  ) => {
    const documentIdentities = new Set(documentIssues.map(getIssueIdentity));
    return [
      ...documentIssues,
      ...providerIssues.filter((issue) => !documentIdentities.has(getIssueIdentity(issue)))
    ];
  };

  /**
   * 重写合并视图。只有文档 issue 或 provider issue 真变化的节点才产生新数组，
   * 其余沿用旧数组身份，节点 snapshot 缓存才不会整表失效。
   * 节点已从文档消失时，provider 分桶与合并结果一起清理。
   */
  const syncMergedView = (nodeIds: ReadonlySet<string>) => {
    const next = new Map(issuesByNode);
    nodeIds.forEach((nodeId) => {
      if (!document.getNodeById(nodeId)) {
        next.delete(nodeId);
        providerIssuesByNode.delete(nodeId);
        return;
      }
      const documentIssues = documentIssuesByNode.get(nodeId) ?? [];
      const providerIssues = providerIssuesByNode.get(nodeId);
      const merged = providerIssues?.length
        ? mergeIssues(documentIssues, providerIssues)
        : documentIssues;
      const previous = next.get(nodeId);
      if (previous === merged || (previous && valuesEqual(previous, merged))) return;
      next.set(nodeId, merged);
    });
    issuesByNode = next;
  };

  /**
   * 组装 provider 入参：当前派生阶段对应文档的零拷贝只读视图。
   * provider 是同步调用且只返回 issue，不会持有 snapshot，因此不做整份文档深拷贝；
   * 只冻结外层容器，深层不可变由 DeepReadonly 类型约束：provider 必须只读，不能写回文档。
   */
  const buildProviderSnapshot = (): WorkflowSnapshot => {
    const current = document.getDocument();
    return Object.freeze({
      nodes: Object.freeze(
        current.nodes.map((node) =>
          Object.freeze({ ...node.data, issues: getNodeIssues(node.data.nodeId) })
        )
      ),
      edges: Object.freeze(current.edges.map((edge) => edge.data)),
      chatConfig: current.chatConfig,
      issues: Object.freeze([...issuesByNode.values()].flatMap((issues) => issues))
    }) as unknown as WorkflowSnapshot;
  };

  /**
   * 调用 provider 并按 scope 归集结果。provider 属于 editor 代码：抛错时返回 undefined，
   * 调用方保留上一轮结果，事务与派生状态不被外部异常破坏。
   * scope 外与文档中不存在的 nodeId 一律丢弃，定向刷新不会污染其它节点。
   */
  const runIssueProvider = (scope: WorkflowIssueScope) => {
    if (!issueProvider) return undefined;
    const scoped = scope === 'all' ? undefined : new Set(scope);
    const produced = new Map<string, WorkflowCheckIssue[]>();
    try {
      issueProvider({ workflow: buildProviderSnapshot(), nodeIds: scope }).forEach((issue) => {
        if (scoped && !scoped.has(issue.nodeId)) return;
        if (!document.getNodeById(issue.nodeId)) return;
        const issues = produced.get(issue.nodeId) ?? [];
        if (issues.some((item) => getIssueIdentity(item) === getIssueIdentity(issue))) return;
        issues.push(issue);
        produced.set(issue.nodeId, issues);
      });
    } catch {
      return undefined;
    }
    return produced;
  };

  /**
   * 只重跑 provider：文档 issue、History、Savepoint 与 Content Revision 都不参与。
   * 全量刷新会清掉本轮没有产出的旧分桶，定向刷新只替换 scope 内节点。
   * 返回合并视图实际变化的节点，供 Runtime Core 发 issue-only 通知与 affected records。
   */
  const refreshProviderIssues = (scope: WorkflowIssueScope): string[] => {
    const produced = runIssueProvider(scope);
    if (!produced) return [];
    const candidates = new Set<string>([
      ...produced.keys(),
      ...(scope === 'all' ? providerIssuesByNode.keys() : scope)
    ]);
    const touched = new Set<string>();
    candidates.forEach((nodeId) => {
      const next = produced.get(nodeId) ?? [];
      const previous = providerIssuesByNode.get(nodeId) ?? [];
      if (next.length === 0) {
        if (previous.length === 0) return;
        providerIssuesByNode.delete(nodeId);
      } else {
        providerIssuesByNode.set(nodeId, valuesEqual(previous, next) ? previous : next);
      }
      touched.add(nodeId);
    });
    const before = issuesByNode;
    syncMergedView(touched);
    return [...touched].filter((nodeId) => before.get(nodeId) !== issuesByNode.get(nodeId));
  };

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
      ? new Map(documentIssuesByNode)
      : new Map<string, WorkflowCheckIssue[]>();
    if (!onlyNodeIds) reachableNodeIds = calculateReachableNodeIds();
    const touchedNodeIds = new Set<string>();

    current.nodes
      .filter((node) => !onlyNodeIds || onlyNodeIds.has(node.data.nodeId))
      .forEach((node) => {
        const issues: WorkflowCheckIssue[] = [];
        const addIssue = (
          code: WorkflowIssueCode,
          inputKey?: string,
          params?: Record<string, string>
        ) => {
          if (issues.some((issue) => issue.code === code && issue.inputKey === inputKey)) return;
          issues.push({
            nodeId: node.data.nodeId,
            level: 'error',
            code,
            ...(inputKey ? { inputKey } : {}),
            ...(params ? { params } : {})
          });
        };

        node.data.inputs.forEach((input) => {
          const value = input.value ?? input.defaultValue;
          if (input.required && isEmptyValue(value)) {
            addIssue('required_input_empty', input.key, { inputName: input.label ?? input.key });
          }
          reference.getFieldStatuses(node.data.nodeId, input).forEach((status) => {
            const issue = issueForStatus({ node, input, status });
            if (!issue) return;
            addIssue(issue.code, issue.inputKey, issue.params);
          });
        });

        collectNodeTypeIssues({
          node,
          nodes: current.nodes,
          graphIndex,
          isSourceEdgeValid
        }).forEach(({ code, inputKey }) => addIssue(code, inputKey));

        const incoming = (graphIndex.byTarget.get(node.data.nodeId) ?? []).some((edge) =>
          isSourceEdgeValid(edge)
        );
        if (!incoming && !noUpstreamExemptTypes.has(node.data.flowNodeType)) {
          addIssue('no_upstream');
        } else if (
          incoming &&
          reachableNodeIds.size > 0 &&
          !reachableNodeIds.has(node.data.nodeId) &&
          !noUpstreamExemptTypes.has(node.data.flowNodeType)
        ) {
          addIssue('unreachable_from_start');
        }
        const previous = documentIssuesByNode.get(node.data.nodeId);
        nextIssues.set(
          node.data.nodeId,
          previous && valuesEqual(previous, issues) ? previous : issues
        );
        touchedNodeIds.add(node.data.nodeId);
      });
    onlyNodeIds?.forEach((nodeId) => {
      if (document.getNodeById(nodeId)) return;
      nextIssues.delete(nodeId);
      touchedNodeIds.add(nodeId);
    });
    documentIssuesByNode = nextIssues;
    // 全量重建后合并视图里可能残留已删除节点，按新旧 key 并集一起清理。
    if (!onlyNodeIds) issuesByNode.forEach((_issues, nodeId) => touchedNodeIds.add(nodeId));
    syncMergedView(touchedNodeIds);
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
    // provider 读同一笔事务提交后的文档，范围与文档检查保持一致。
    refreshProviderIssues([...candidateNodeIds]);
    addChangedIssueRecords(meta, previousIssues, candidateNodeIds);
  };

  /** 全量重建：初始化、replaceDocument 与整份文档回放后使用。 */
  const rebuildAll = () => {
    rebuildIssues();
    refreshProviderIssues('all');
  };

  const clear = () => {
    documentIssuesByNode = new Map();
    providerIssuesByNode = new Map();
    issuesByNode = new Map();
    configIssues = [];
    reachableNodeIds = new Set();
  };

  return {
    getIssuesByNode,
    getNodeIssues,
    getConfigIssues,
    rebuildIssues,
    rebuildAll,
    refreshProviderIssues,
    addChangedIssueRecords,
    collectTransactionNodeIds,
    rebuildForTransaction,
    clear
  };
};
