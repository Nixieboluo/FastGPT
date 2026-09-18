// [workflow-runtime-cutover] 临时兼容桥：撤销重做完全走 Runtime History；
// past/future 数组退化为 host 版本列表的兼容视图（现有 UI 只读 title 并回传条目）。
// 迁移结束后薄壳随调用点改造删除。
import { materializeWorkflow } from '@/web/core/workflow/editor/codec';
import {
  WorkflowRuntimeHostContext,
  type WorkflowVersionEntry
} from '@/web/core/workflow/editor/cutover/runtimeHost';
import type { AppChatConfigType } from '@fastgpt/global/core/app/type';
import type { AppVersionSchemaType } from '@fastgpt/global/core/app/version/type';
import { useMemoEnhance } from '@fastgpt/web/hooks/useMemoEnhance';
import { useMemoizedFn } from 'ahooks';
import { useTranslation } from 'next-i18next';
import React from 'react';
import type { Edge, Node } from 'reactflow';
import { createContext, useContextSelector } from 'use-context-selector';

export type WorkflowSnapshotsType = {
  nodes: Node[];
  edges: Edge[];
  chatConfig: AppChatConfigType;
  title: string;
  isSaved?: boolean;
};

// 创建 Context
type WorkflowSnapshotContextValue = {
  /** 历史快照列表（兼容视图：host 版本列表，nodes/edges 恒为空数组） */
  past: WorkflowSnapshotsType[];

  /** 设置历史快照列表（拦截 Header 保存成功后的 isSaved 标记，回填 Savepoint） */
  setPast: React.Dispatch<React.SetStateAction<WorkflowSnapshotsType[]>>;

  /** 未来快照列表（Runtime History 接管后恒为空） */
  future: WorkflowSnapshotsType[];

  /** 撤销 */
  undo: () => void;

  /** 重做 */
  redo: () => void;

  /** 是否可以撤销 */
  canUndo: boolean;

  /** 是否可以重做 */
  canRedo: boolean;

  /** 推入历史快照（Runtime History 接管后为空操作） */
  pushPastSnapshot: (params: {
    pastNodes: Node[];
    pastEdges: Edge[];
    chatConfig: AppChatConfigType;
    customTitle?: string;
    isSaved?: boolean;
  }) => boolean;

  /** 切换临时版本 */
  onSwitchTmpVersion: (data: WorkflowSnapshotsType, customTitle: string) => boolean;

  /** 切换云端版本 */
  onSwitchCloudVersion: (appVersion: AppVersionSchemaType) => boolean;
};
export const WorkflowSnapshotContext = createContext<WorkflowSnapshotContextValue>({
  past: [],
  setPast: function (_value: React.SetStateAction<WorkflowSnapshotsType[]>): void {
    throw new Error('Function not implemented.');
  },
  future: [],
  undo: function (): void {
    throw new Error('Function not implemented.');
  },
  redo: function (): void {
    throw new Error('Function not implemented.');
  },
  canUndo: false,
  canRedo: false,
  pushPastSnapshot: function (_params: {
    pastNodes: Node[];
    pastEdges: Edge[];
    chatConfig: AppChatConfigType;
    customTitle?: string;
    isSaved?: boolean;
  }): boolean {
    throw new Error('Function not implemented.');
  },
  onSwitchTmpVersion: function (_data: WorkflowSnapshotsType, _customTitle: string): boolean {
    throw new Error('Function not implemented.');
  },
  onSwitchCloudVersion: function (_appVersion: AppVersionSchemaType): boolean {
    throw new Error('Function not implemented.');
  }
});

export const WorkflowSnapshotProvider = ({ children }: { children: React.ReactNode }) => {
  const { t } = useTranslation();

  const runtime = useContextSelector(WorkflowRuntimeHostContext, (v) => v.runtime);
  const runtimeTick = useContextSelector(WorkflowRuntimeHostContext, (v) => v.runtimeTick);
  const versions = useContextSelector(WorkflowRuntimeHostContext, (v) => v.versions);
  const setVersions = useContextSelector(WorkflowRuntimeHostContext, (v) => v.setVersions);
  const markSavedPending = useContextSelector(
    WorkflowRuntimeHostContext,
    (v) => v.markSavedPending
  );
  const switchVersion = useContextSelector(WorkflowRuntimeHostContext, (v) => v.switchVersion);

  const undo = useMemoizedFn(() => {
    runtime?.undo();
  });
  const redo = useMemoizedFn(() => {
    runtime?.redo();
  });

  const history = runtime && !runtime.isDisposed() ? runtime.getHistory() : undefined;
  // runtimeTick 参与渲染读取，保证 undo/redo/命令提交后可用性即时刷新。
  void runtimeTick;

  /**
   * Header 保存成功后用 setPast 给 index 0 标 isSaved；这里拦截为 Savepoint 回填
   * （按发起保存请求前捕获的内容版本，请求期间的新编辑仍算未保存）。
   */
  const setPast = useMemoizedFn((action: React.SetStateAction<WorkflowSnapshotsType[]>) => {
    const next =
      typeof action === 'function'
        ? (action as (prev: WorkflowSnapshotsType[]) => WorkflowSnapshotsType[])(versions)
        : action;
    if (next[0]?.isSaved) {
      markSavedPending();
    }
    setVersions(next as WorkflowVersionEntry[]);
  });

  const pushPastSnapshot = useMemoizedFn(
    (_params: Parameters<WorkflowSnapshotContextValue['pushPastSnapshot']>[0]) => {
      // 历史由 Runtime 在每笔事务内维护，旧防抖快照不再需要。
      return false;
    }
  );

  const onSwitchTmpVersion = useMemoizedFn((params: WorkflowSnapshotsType, customTitle: string) =>
    switchVersion(params as WorkflowVersionEntry, customTitle)
  );

  const onSwitchCloudVersion = useMemoizedFn((appVersion: AppVersionSchemaType) => {
    if (!runtime || runtime.isDisposed()) return false;
    // 云端版本是存量 store 数据，必须走与打开工作流相同的入站边界（migration + 物化）。
    const content = materializeWorkflow({
      input: { nodes: appVersion.nodes, edges: appVersion.edges },
      chatConfig: appVersion.chatConfig,
      t
    });
    return switchVersion(
      {
        title: `${t('app:version_copy')}-${appVersion.versionName}`,
        content,
        nodes: [],
        edges: [],
        chatConfig: content.chatConfig
      },
      `${t('app:version_copy')}-${appVersion.versionName}`
    );
  });

  const contextValue = useMemoEnhance(
    () => ({
      past: versions as WorkflowSnapshotsType[],
      setPast,
      future: [] as WorkflowSnapshotsType[],
      undo,
      redo,
      canUndo: history?.canUndo ?? false,
      canRedo: history?.canRedo ?? false,
      pushPastSnapshot,
      onSwitchTmpVersion,
      onSwitchCloudVersion
    }),
    [
      versions,
      setPast,
      undo,
      redo,
      history?.canUndo,
      history?.canRedo,
      pushPastSnapshot,
      onSwitchTmpVersion,
      onSwitchCloudVersion
    ]
  );

  return (
    <WorkflowSnapshotContext.Provider value={contextValue}>
      {children}
    </WorkflowSnapshotContext.Provider>
  );
};
