import { useCallback, useMemo } from 'react';
import { useContextSelector } from 'use-context-selector';
import type { FlowNodeItemType } from '@fastgpt/global/core/workflow/type/node';
import type { WorkflowGraphQueries } from '@fastgpt/global/core/workflow/editor/types';
import { useWorkflowValue } from '@/web/core/workflow/editor';
import { useWorkflowSnapshot, WorkflowHostContext } from '@/web/core/workflow/editor/host';

/**
 * 读取最新文档快照的稳定入口：不订阅工作流数据 Context，也不订阅任何计数器，
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
 * Runtime 图查询对象：按已提交的图索引查容器子节点与连线，代替 app 侧自建
 * nodeMap / childrenNodeIdListMap（06 总纲决策 4、5）。
 *
 * 非订阅读取：对象身份在 runtime 生命周期内不变，可直接当 memo 依赖；
 * 重算时机由调用方的语义快照（`useWorkflowDocument().workflow`）或 `useWorkflowValue` 决定。
 */
export const useGraphQueries = (): WorkflowGraphQueries | undefined => {
  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);

  return useMemo(() => runtime?.getGraphQueries(), [runtime]);
};

/**
 * 稳定的「按 id 取文档节点」函数：getRefData / getEditorVariables 等纯函数只接受 getNodeById 入参，
 * 这里走 port 的 getNode 并收敛成恒定签名，避免每个调用点各写一遍兜底并让 memo 依赖失效。
 *
 * 非订阅读取，读到的永远是当前值；只读快照与纯函数入参只差 readonly 修饰，
 * 桥接统一在这里做一次，纯函数签名不动。
 */
export const useDocumentGetNodeById = () => {
  const runtime = useContextSelector(WorkflowHostContext, (v) => v.runtime);

  return useCallback(
    (nodeId: string | null | undefined) =>
      nodeId && runtime && !runtime.isDisposed()
        ? (runtime.getNode(nodeId) as unknown as FlowNodeItemType | undefined)
        : undefined,
    [runtime]
  );
};

/**
 * 常驻派生列表（变量列表、编辑器变量、可用引用）的读取入口。
 *
 * `workflow` 是语义通道的快照身份，也是派生计算唯一的缓存 key：Runtime 只在语义版本变化时
 * 更换它，纯几何提交、overlay 写入与标红焦点都不换，所以拖拽落点、写 debug 结果与搜索高亮
 * 都不会让派生列表重算。用快照对象本身而不是计数器当 key 是安全的——同一语义版本内
 * getWorkflow() 返回同一个缓存对象，不存在「两个版本共用一份派生」的可能。
 *
 * `getNodeById` 与 `graph` 都是稳定引用（只随 runtime 变）且读当前值，
 * 因此它们进 memo 依赖不会造成额外重算，重算时机完全由 `workflow` 决定。
 */
export const useWorkflowDocument = () => {
  const workflow = useWorkflowSnapshot();
  const getNodeById = useDocumentGetNodeById();
  const graph = useGraphQueries();

  return { workflow, getNodeById, graph };
};

/**
 * 当前节点是否被 Agent 当作工具引用：按结构快照里指向该节点的 selectedTools 入边判定。
 *
 * 判定走 Runtime 图查询（`isMountedTool` 读 byTarget 索引，O(入度)），selector 只返回 boolean，
 * 所以别处连线/断线不会让每个调用它的节点组件重渲染；字段编辑与几何提交本来就不通知结构通道。
 */
export const useIsToolNode = (nodeId: string) =>
  useWorkflowValue((_structure, graph) => graph.isMountedTool(nodeId));
