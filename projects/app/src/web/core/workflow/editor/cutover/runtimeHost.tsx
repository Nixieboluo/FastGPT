// [workflow-runtime-cutover] 临时兼容桥：host 层。拥有 Runtime 生命周期、视图 overlay、
// 版本列表与保存点回填。旧 Context 薄壳都从这里取数；迁移结束后本文件随 cutover 目录删除。
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction
} from 'react';
import { useMemoizedFn } from 'ahooks';
import { isEqual } from 'lodash-es';
import { useTranslation } from 'next-i18next';
import { createContext, useContextSelector } from 'use-context-selector';
import type { Edge, Node } from 'reactflow';
import type { AppChatConfigType } from '@fastgpt/global/core/app/type';
import type { CanonicalWorkflowData } from '@fastgpt/global/core/workflow/migration';
import { hydrateWorkflowEditor } from '@/web/core/workflow/editor';
import type { WorkflowRuntimePort } from '@fastgpt/global/core/workflow/editor/types';
import { AppContext } from '@/pageComponents/app/detail/context';
import type { ViewOverlayPatch } from './translate';
import type { ViewDataOverlayMap } from './projection';

/**
 * 版本列表条目。nodes/edges/chatConfig 是旧 WorkflowSnapshotsType 的兼容形状
 * （现有 UI 只读 title），content 是切换用的冻结文档，live 条目代表当前 Runtime 状态。
 */
export type WorkflowVersionEntry = {
  title: string;
  isSaved?: boolean;
  nodes: Node[];
  edges: Edge[];
  chatConfig: AppChatConfigType;
  content?: CanonicalWorkflowData;
  live?: boolean;
};

export type WorkflowRuntimeHostValue = {
  runtime: WorkflowRuntimePort | null;
  /** runtime 事件与 overlay 写入共用一个计数器，驱动投影重算。 */
  runtimeTick: number;
  overlaysRef: MutableRefObject<ViewDataOverlayMap>;
  patchViewData: (patches: ViewOverlayPatch[]) => void;
  clearOverlays: () => void;
  versions: WorkflowVersionEntry[];
  setVersions: (action: SetStateAction<WorkflowVersionEntry[]>) => void;
  /** flowData2StoreData 在发起保存前捕获的内容版本；保存成功后回填 Savepoint。 */
  pendingSaveRevision: MutableRefObject<number | undefined>;
  markSavedPending: () => void;
  initRuntime: (content: CanonicalWorkflowData) => void;
  loadDocument: (content: CanonicalWorkflowData) => void;
  switchVersion: (entry: WorkflowVersionEntry, customTitle: string) => boolean;
};

const notImplemented = (): never => {
  throw new Error('WorkflowRuntimeHost missing');
};

export const WorkflowRuntimeHostContext = createContext<WorkflowRuntimeHostValue>({
  runtime: null,
  runtimeTick: 0,
  overlaysRef: { current: {} },
  patchViewData: notImplemented,
  clearOverlays: notImplemented,
  versions: [],
  setVersions: notImplemented,
  pendingSaveRevision: { current: undefined },
  markSavedPending: notImplemented,
  initRuntime: notImplemented,
  loadDocument: notImplemented,
  switchVersion: notImplemented
});

export const WorkflowRuntimeHostProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  const setAppDetail = useContextSelector(AppContext, (v) => v.setAppDetail);
  const appDetailChatConfig = useContextSelector(AppContext, (v) => v.appDetail.chatConfig);

  const [runtime, setRuntime] = useState<WorkflowRuntimePort | null>(null);
  const runtimeRef = useRef<WorkflowRuntimePort | null>(null);
  const [runtimeTick, setRuntimeTick] = useState(0);
  const overlaysRef = useRef<ViewDataOverlayMap>({});
  const [versions, setVersionsRaw] = useState<WorkflowVersionEntry[]>([]);
  const versionsRef = useRef<WorkflowVersionEntry[]>([]);
  const pendingSaveRevision = useRef<number | undefined>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  // 订阅回调里回写 appDetail，用 ref 避免 chatConfig 变化导致重新订阅。
  const setAppDetailRef = useRef(setAppDetail);
  useEffect(() => {
    setAppDetailRef.current = setAppDetail;
  }, [setAppDetail]);

  const bump = useMemoizedFn(() => {
    setRuntimeTick((tick) => tick + 1);
  });

  const teardownRuntime = useMemoizedFn(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    if (runtimeRef.current && !runtimeRef.current.isDisposed()) {
      runtimeRef.current.dispose();
    }
    runtimeRef.current = null;
  });

  useEffect(
    () => () => {
      teardownRuntime();
    },
    [teardownRuntime]
  );

  const attachRuntime = useMemoizedFn((next: WorkflowRuntimePort) => {
    teardownRuntime();
    runtimeRef.current = next;
    unsubscribeRef.current = next.subscribe((change) => {
      // undo/redo/replace 恢复文档 chatConfig 时回写 appDetail（旧路径由 resetSnapshot 负责）。
      if (change.changedRecords.chatConfig && !next.isDisposed()) {
        // snapshot 是 DeepReadonly；appDetail 需要可变类型，这里只做引用替换不修改内容。
        const nextConfig = next.getWorkflow().chatConfig as unknown as AppChatConfigType;
        setAppDetailRef.current((detail) =>
          isEqual(detail.chatConfig, nextConfig) ? detail : { ...detail, chatConfig: nextConfig }
        );
      }
      bump();
    });
    setRuntime(next);
  });

  // SystemConfigDrawer 只写 appDetail.chatConfig；这里单向同步进文档（相等时跳过，避免死循环）。
  useEffect(() => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) return;
    const docConfig = current.getWorkflow().chatConfig;
    if (!isEqual(docConfig, appDetailChatConfig)) {
      current.dispatch({ type: 'updateChatConfig', chatConfig: appDetailChatConfig });
    }
  }, [runtime, appDetailChatConfig]);

  const setVersions = useMemoizedFn((action: SetStateAction<WorkflowVersionEntry[]>) => {
    const next = typeof action === 'function' ? action(versionsRef.current) : action;
    versionsRef.current = next;
    setVersionsRaw(next);
  });

  const initRuntime = useMemoizedFn((content: CanonicalWorkflowData) => {
    attachRuntime(hydrateWorkflowEditor(content));
    overlaysRef.current = {};
    pendingSaveRevision.current = undefined;
    const initialTitle = t('app:app.version_initial');
    setVersions([
      {
        title: initialTitle,
        isSaved: true,
        live: true,
        nodes: [],
        edges: [],
        chatConfig: content.chatConfig
      },
      {
        title: initialTitle,
        isSaved: true,
        content,
        nodes: [],
        edges: [],
        chatConfig: content.chatConfig
      }
    ]);
    bump();
  });

  /** 导入等重载路径：保留 Runtime 实例与历史（导入可撤销），整文档替换并清视图数据。 */
  const loadDocument = useMemoizedFn((content: CanonicalWorkflowData) => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) {
      initRuntime(content);
      return;
    }
    const res = current.dispatch({ type: 'replaceDocument', document: content });
    if (!res.ok) return;
    overlaysRef.current = {};
    pendingSaveRevision.current = undefined;
    bump();
  });

  /**
   * 版本切换：冻结当前内容为新条目，替换文档并同步 chatConfig。
   * live 条目代表当前状态，切换到它是无操作（与旧行为“切到最新快照”等价）。
   */
  const switchVersion = useMemoizedFn(
    (entry: WorkflowVersionEntry, customTitle: string): boolean => {
      const current = runtimeRef.current;
      if (!current || current.isDisposed()) return false;
      if (entry.live || !entry.content) return true;

      // 旧路径会折叠重复的“版本复制-版本复制-”前缀。
      const copyText = t('app:version_copy');
      const title = customTitle.replace(new RegExp(`(${copyText}-)\\1+`, 'g'), '$1');
      const frozenCurrent = current.getWorkflowData();
      const prevLive = versionsRef.current[0];
      const res = current.dispatch({ type: 'replaceDocument', document: entry.content });
      if (!res.ok) return false;

      overlaysRef.current = {};
      pendingSaveRevision.current = undefined;
      setVersions([
        {
          title,
          live: true,
          nodes: [],
          edges: [],
          chatConfig: entry.content.chatConfig
        },
        {
          title: prevLive?.title ?? title,
          isSaved: prevLive?.isSaved,
          content: frozenCurrent,
          nodes: [],
          edges: [],
          chatConfig: frozenCurrent.chatConfig
        },
        // 被切换的条目由新 LIVE 取代，按引用移除；旧行为是把它从 past 挪走，
        // 保留原条目会让同一内容在列表里越积越多（重复记录）。
        ...versionsRef.current.slice(1).filter((item) => item !== entry)
      ]);
      const nextChatConfig = entry.content.chatConfig;
      setAppDetail((detail) => ({ ...detail, chatConfig: nextChatConfig }));
      return true;
    }
  );

  const markSavedPending = useMemoizedFn(() => {
    const current = runtimeRef.current;
    if (!current) return;
    current.markSaved(pendingSaveRevision.current ?? current.getSavepoint().contentRevision);
    bump();
  });

  const patchViewData = useMemoizedFn((patches: ViewOverlayPatch[]) => {
    if (patches.length === 0) return;
    const next = { ...overlaysRef.current };
    patches.forEach(({ nodeId, values }) => {
      next[nodeId] = { ...next[nodeId], ...values };
    });
    overlaysRef.current = next;
    bump();
  });

  const clearOverlays = useMemoizedFn(() => {
    if (Object.keys(overlaysRef.current).length === 0) return;
    overlaysRef.current = {};
    bump();
  });

  const value = useMemo(
    () => ({
      runtime,
      runtimeTick,
      overlaysRef,
      patchViewData,
      clearOverlays,
      versions,
      setVersions,
      pendingSaveRevision,
      markSavedPending,
      initRuntime,
      loadDocument,
      switchVersion
    }),
    [
      runtime,
      runtimeTick,
      versions,
      patchViewData,
      clearOverlays,
      setVersions,
      markSavedPending,
      initRuntime,
      loadDocument,
      switchVersion
    ]
  );

  return (
    <WorkflowRuntimeHostContext.Provider value={value}>
      {children}
    </WorkflowRuntimeHostContext.Provider>
  );
};
