import { useCallback, useMemo } from 'react';
import { useContextSelector } from 'use-context-selector';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { useWorkflow } from '@/web/core/workflow/editor';
import { getWorkflowGraphReader } from '@/web/core/workflow/utils';
import { WorkflowHostContext } from '@/web/core/workflow/editor/host';

/**
 * 读取最新文档快照的稳定入口：不订阅工作流数据 Context，也不订阅 runtimeTick，
 * 因此文档变化不会让调用方重渲染。供「打开时一次性计算」的场景（引用选择器）使用。
 */
export const useWorkflowSnapshotGetter = () => {
  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);

  return useCallback(
    () => (runtime && !runtime.isDisposed() ? runtime.getWorkflow() : undefined),
    [runtime]
  );
};

/**
 * 常驻派生列表（变量列表、编辑器变量）的读取入口。
 *
 * 派生计算改为普通纯函数后需要一个重算触发点，这里用 host 的 runtimeTick（一个数字）而不是
 * 数据 Context：只有文档变化才重渲染，几何与选中等本地交互不会。
 * getWorkflow() 有版本缓存，图索引再按 snapshot 身份缓存，同一语义版本内所有字段共用一份。
 */
export const useWorkflowDocument = () => {
  const getWorkflow = useWorkflowSnapshotGetter();
  const runtimeTick = useContextSelector(WorkflowHostContext, (v) => v.runtimeTick);

  const reader = useMemo(() => {
    const workflow = getWorkflow();
    return workflow ? getWorkflowGraphReader(workflow) : undefined;
    // runtimeTick 是刻意的缓存 key：不建数据订阅，但文档变化后要重算派生列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getWorkflow, runtimeTick]);

  return { getWorkflow, reader };
};

/**
 * 稳定的「按 id 取文档节点」函数：getRefData / getEditorVariables 等纯函数只接受 getNodeById 入参，
 * 这里把可选的 reader 收敛成恒定签名，避免每个调用点各写一遍兜底并让 memo 依赖失效。
 */
export const useDocumentGetNodeById = () => {
  const { reader } = useWorkflowDocument();

  return useCallback((nodeId: string | null | undefined) => reader?.getNodeById(nodeId), [reader]);
};

/**
 * 当前节点是否被 Agent 当作工具引用：按结构快照里指向该节点的 selectedTools 入边判定。
 *
 * 旧实现读薄壳的 toolNodesMap，这里改读 adapter 结构 handle，只在结构变化时重算，
 * 字段编辑不会带动使用它的节点组件。
 */
export const useIsToolNode = (nodeId: string) => {
  const { edges } = useWorkflow();

  return useMemo(
    () =>
      edges.some(
        (edge) => edge.target === nodeId && edge.targetHandle === NodeOutputKeyEnum.selectedTools
      ),
    [edges, nodeId]
  );
};
