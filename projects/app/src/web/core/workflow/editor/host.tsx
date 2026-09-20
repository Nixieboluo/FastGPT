/**
 * 工作流编辑器 host 层：编辑器唯一的数据与生命周期边界。
 *
 * 拥有 Runtime 生命周期与 adapter 挂载、版本列表与整文档替换切换、Savepoint 与出站序列化入口、
 * Environment Issue 定时扫描与按节点问题存储、本地草稿与离开保护。
 * overlay/patchViewData 与投影供数是迁移期兼容面，随调用点迁移票逐步迁出。
 */
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react';
import { useMemoizedFn } from 'ahooks';
import { isEqual } from 'lodash-es';
import { useTranslation } from 'next-i18next';
import { createContext, useContextSelector } from 'use-context-selector';
import { formatTime2YMDHMS } from '@fastgpt/global/common/string/time';
import type { AppChatConfigType } from '@fastgpt/global/core/app/type';
import type { AppVersionSchemaType } from '@fastgpt/global/core/app/version/type';
import {
  hydrateWorkflowEditor,
  type StoreWorkflow
} from '@fastgpt/global/core/workflow/editor/protocol';
import type { WorkflowRuntimePort } from '@fastgpt/global/core/workflow/editor/types';
import type { CanonicalWorkflowData } from '@fastgpt/global/core/workflow/migration';
import type {
  WorkflowCheckIssue,
  WorkflowCheckNodeIssueMap
} from '@fastgpt/global/core/workflow/type/node';
import { useWorkflowDraftLifecycle } from '@/web/core/workflow/localDraft/useWorkflowDraftLifecycle';
import { getWorkflowModelDetails } from '@/web/core/workflow/modelData';
import { checkWorkflowNodeIssues } from '@/web/core/workflow/workflowCheck';
import { AppContext } from '@/pageComponents/app/detail/context';
import { materializeWorkflow, serializeRuntime } from './codec';
import {
  createProjectionCache,
  projectRuntimeCanvas,
  type ViewDataOverlayMap
} from './cutover/projection';
import type { ViewOverlayPatch } from './cutover/translate';
import { WorkflowEditorProvider } from './react';

/** Environment Issue 定时扫描间隔。 */
const ENVIRONMENT_SCAN_INTERVAL = 10_000;
/** Runtime 最多保留 100 笔 history；版本列表包含当前状态，因此最多 101 项。 */
const MAX_VERSION_ENTRIES = 101;

/** 扫描用空 overlay：问题检查只读文档投影，不受视图数据影响。 */
const EMPTY_OVERLAYS: ViewDataOverlayMap = {};

/**
 * 版本列表条目。每笔 Runtime command 记录一份冻结文档，live 标记当前版本。
 */
export type WorkflowVersionEntry = {
  title: string;
  content?: CanonicalWorkflowData;
  contentRevision?: number;
  live?: boolean;
};

export type WorkflowHostValue = {
  runtime: WorkflowRuntimePort | null;
  /** runtime 事件与 overlay 写入共用一个计数器，驱动投影重算与派生状态刷新。 */
  runtimeTick: number;

  /** 迁移期兼容面：host 持有的按节点视图数据，投影时合并进画布节点。 */
  overlaysRef: MutableRefObject<ViewDataOverlayMap>;
  patchViewData: (patches: ViewOverlayPatch[]) => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  versions: WorkflowVersionEntry[];
  switchVersion: (entry: WorkflowVersionEntry, customTitle: string) => boolean;
  switchCloudVersion: (appVersion: AppVersionSchemaType) => boolean;

  /** 当前内容是否等于已保存内容；撤销回已保存内容会自然回到已保存态。 */
  isSaved: boolean;
  /** 置 false 表示主动离开，跳过离开保护与自动保存。 */
  leaveSaveSign: MutableRefObject<boolean>;
  /** 出站序列化（保存、发布、草稿、调试共用）；同时捕获内容版本供 markSaved 回填。 */
  serializeWorkflow: () => StoreWorkflow | undefined;
  /** 保存成功后回填 Savepoint；失败不调用即不回填，请求期间的新编辑仍算未保存。 */
  markSaved: () => void;

  /** 按节点问题存储：定时扫描与保存/发布 gate 写同一份。 */
  issuesRef: MutableRefObject<WorkflowCheckNodeIssueMap>;
  /** 全量覆盖问题存储，map 外的旧问题一并清除。 */
  syncIssues: (issueMap: WorkflowCheckNodeIssueMap) => void;
  /** 局部改写单节点问题（节点配置编辑后的防抖复查）。 */
  setNodeIssues: (nodeId: string, issues: WorkflowCheckIssue[] | undefined) => void;
  /** 清空问题存储与问题文案；isError 与选中态属于渲染层，由调用方处理。 */
  clearIssues: () => void;

  initRuntime: (content: CanonicalWorkflowData) => void;
  loadDocument: (content: CanonicalWorkflowData) => void;
};

const notImplemented = (): never => {
  throw new Error('WorkflowHost missing');
};

export const WorkflowHostContext = createContext<WorkflowHostValue>({
  runtime: null,
  runtimeTick: 0,
  overlaysRef: { current: {} },
  patchViewData: notImplemented,
  undo: notImplemented,
  redo: notImplemented,
  canUndo: false,
  canRedo: false,
  versions: [],
  switchVersion: notImplemented,
  switchCloudVersion: notImplemented,
  isSaved: true,
  leaveSaveSign: { current: true },
  serializeWorkflow: notImplemented,
  markSaved: notImplemented,
  issuesRef: { current: {} },
  syncIssues: notImplemented,
  setNodeIssues: notImplemented,
  clearIssues: notImplemented,
  initRuntime: notImplemented,
  loadDocument: notImplemented
});

/**
 * 编辑器 host Provider：挂在 ReactFlowProvider 内、renderer 之上。
 * Runtime 为 null（尚未 hydrate）时不挂 adapter，其余编辑器状态照常供给。
 */
export const WorkflowHostProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  const setAppDetail = useContextSelector(AppContext, (v) => v.setAppDetail);
  const appDetailChatConfig = useContextSelector(AppContext, (v) => v.appDetail.chatConfig);

  const [runtime, setRuntime] = useState<WorkflowRuntimePort | null>(null);
  const runtimeRef = useRef<WorkflowRuntimePort | null>(null);
  const [runtimeTick, setRuntimeTick] = useState(0);
  const overlaysRef = useRef<ViewDataOverlayMap>({});
  const [versions, setVersionsRaw] = useState<WorkflowVersionEntry[]>([]);
  const versionsRef = useRef<WorkflowVersionEntry[]>([]);
  const suppressVersionHistoryRef = useRef(false);
  const pendingSaveRevision = useRef<number | undefined>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const leaveSaveSign = useRef(true);
  const issuesRef = useRef<WorkflowCheckNodeIssueMap>({});
  // 扫描用的独立投影缓存：与画布投影的 overlay/交互状态不同，不能共用。
  const scanProjectionCache = useRef(createProjectionCache());
  // 订阅回调里回写 appDetail，用 ref 避免 chatConfig 变化导致重新订阅。
  const setAppDetailRef = useRef(setAppDetail);
  useEffect(() => {
    setAppDetailRef.current = setAppDetail;
  }, [setAppDetail]);

  const bump = useMemoizedFn(() => {
    setRuntimeTick((tick) => tick + 1);
  });

  const setVersions = useMemoizedFn((next: WorkflowVersionEntry[]) => {
    versionsRef.current = next;
    setVersionsRaw(next);
  });

  /** 每笔成功 command 立即记录，不对连续字段输入做合并。 */
  const recordVersionHistory = useMemoizedFn((current: WorkflowRuntimePort) => {
    const liveIndex = versionsRef.current.findIndex((entry) => entry.live);
    const currentBranch =
      liveIndex >= 0 ? versionsRef.current.slice(liveIndex) : versionsRef.current;
    const nextVersions = [
      {
        title: formatTime2YMDHMS(new Date()),
        content: current.getWorkflowData(),
        contentRevision: current.getSavepoint().contentRevision,
        live: true
      },
      ...currentBranch.map((entry) => (entry.live ? { ...entry, live: false } : entry))
    ];
    setVersions(nextVersions.slice(0, MAX_VERSION_ENTRIES));
  });

  /** undo/redo 只移动当前版本标记，不新增侧边栏记录。 */
  const syncLiveVersion = useMemoizedFn((current: WorkflowRuntimePort) => {
    const contentRevision = current.getSavepoint().contentRevision;
    if (!versionsRef.current.some((entry) => entry.contentRevision === contentRevision)) return;
    setVersions(
      versionsRef.current.map((entry) => ({
        ...entry,
        live: entry.contentRevision === contentRevision
      }))
    );
  });

  const teardownRuntime = useMemoizedFn(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    if (runtimeRef.current && !runtimeRef.current.isDisposed()) {
      runtimeRef.current.dispose();
    }
    runtimeRef.current = null;
  });

  const attachRuntime = useMemoizedFn((next: WorkflowRuntimePort) => {
    teardownRuntime();
    runtimeRef.current = next;
    unsubscribeRef.current = next.subscribe((change) => {
      // undo/redo/replace 恢复文档 chatConfig 时回写 appDetail。
      if (change.changedRecords.chatConfig && !next.isDisposed()) {
        // snapshot 是 DeepReadonly；appDetail 需要可变类型，这里只做引用替换不修改内容。
        const nextConfig = next.getWorkflow().chatConfig as unknown as AppChatConfigType;
        setAppDetailRef.current((detail) =>
          isEqual(detail.chatConfig, nextConfig) ? detail : { ...detail, chatConfig: nextConfig }
        );
      }
      if (change.origin === 'command' && !suppressVersionHistoryRef.current) {
        recordVersionHistory(next);
      } else if (change.origin !== 'command') {
        syncLiveVersion(next);
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

  // runtimeTick 参与派生：命令提交、undo/redo 与 Savepoint 回填都通过它刷新下列状态。
  const history = runtime && !runtime.isDisposed() ? runtime.getHistory() : undefined;
  const isSaved = !runtime || runtime.isDisposed() ? true : !runtime.getSavepoint().isDirty;

  const serializeWorkflow = useMemoizedFn((): StoreWorkflow | undefined => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) return undefined;
    pendingSaveRevision.current = current.getSavepoint().contentRevision;
    return serializeRuntime(current);
  });

  const markSaved = useMemoizedFn(() => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) return;
    const revision = pendingSaveRevision.current ?? current.getSavepoint().contentRevision;
    pendingSaveRevision.current = undefined;
    current.markSaved(revision);
    bump();
  });

  const initRuntime = useMemoizedFn((content: CanonicalWorkflowData) => {
    const nextRuntime = hydrateWorkflowEditor(content);
    attachRuntime(nextRuntime);
    overlaysRef.current = {};
    issuesRef.current = {};
    pendingSaveRevision.current = undefined;
    const initialTitle = t('app:app.version_initial');
    setVersions([
      {
        title: initialTitle,
        content,
        contentRevision: nextRuntime.getSavepoint().contentRevision,
        live: true
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
    issuesRef.current = {};
    pendingSaveRevision.current = undefined;
    bump();
  });

  /** 版本切换只移动当前版本标记，不产生新的“My Edit”记录。 */
  const switchVersion = useMemoizedFn(
    (entry: WorkflowVersionEntry, _customTitle: string): boolean => {
      const current = runtimeRef.current;
      if (!current || current.isDisposed()) return false;
      if (entry.live || !entry.content) return true;

      const targetIndex = versionsRef.current.indexOf(entry);
      if (targetIndex >= 0 && entry.contentRevision !== undefined) {
        while (current.getSavepoint().contentRevision !== entry.contentRevision) {
          const liveIndex = versionsRef.current.findIndex((item) => item.live);
          if (liveIndex < 0) return false;
          const res = targetIndex > liveIndex ? current.undo() : current.redo();
          if (!res.ok) return false;
        }
      } else {
        // 云端版本不属于本地 Runtime History，只抑制“My Edit”新增记录。
        suppressVersionHistoryRef.current = true;
        const res = (() => {
          try {
            return current.dispatch({ type: 'replaceDocument', document: entry.content });
          } finally {
            suppressVersionHistoryRef.current = false;
          }
        })();
        if (!res.ok) return false;
      }

      overlaysRef.current = {};
      issuesRef.current = {};
      pendingSaveRevision.current = undefined;
      setVersions(
        versionsRef.current.map((item) => ({
          ...item,
          live:
            entry.contentRevision !== undefined
              ? item.contentRevision === entry.contentRevision
              : item === entry
        }))
      );
      const nextChatConfig = entry.content.chatConfig;
      setAppDetail((detail) => ({ ...detail, chatConfig: nextChatConfig }));
      return true;
    }
  );

  const switchCloudVersion = useMemoizedFn((appVersion: AppVersionSchemaType) => {
    // 云端版本是存量 store 数据，必须走与打开工作流相同的入站边界（migration + 物化）。
    const content = materializeWorkflow({
      input: { nodes: appVersion.nodes, edges: appVersion.edges },
      chatConfig: appVersion.chatConfig,
      t
    });
    const title = `${t('app:version_copy')}-${appVersion.versionName}`;
    return switchVersion({ title, content }, title);
  });

  const undo = useMemoizedFn(() => {
    runtimeRef.current?.undo();
  });
  const redo = useMemoizedFn(() => {
    runtimeRef.current?.redo();
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

  // 存储是无渲染依赖的读取面，overlay 是渲染权威；按 overlay 现值 diff，无变化时不触发重投影。
  const setNodeIssues = useMemoizedFn(
    (nodeId: string, issues: WorkflowCheckIssue[] | undefined) => {
      const nextIssues = issues?.length ? issues : undefined;
      if (nextIssues) issuesRef.current[nodeId] = nextIssues;
      else delete issuesRef.current[nodeId];

      const current = overlaysRef.current[nodeId]?.workflowCheckIssues;
      if (JSON.stringify(current ?? undefined) === JSON.stringify(nextIssues)) return;
      patchViewData([{ nodeId, values: { workflowCheckIssues: nextIssues } }]);
    }
  );

  /** 全量覆盖：新 map 外的旧问题一并清除（定时扫描与保存/发布 gate 共用）。 */
  const syncIssues = useMemoizedFn((issueMap: WorkflowCheckNodeIssueMap) => {
    const nextStore: WorkflowCheckNodeIssueMap = {};
    const patches: ViewOverlayPatch[] = [];
    const nodeIds = new Set([
      ...Object.keys(issueMap),
      ...Object.keys(issuesRef.current),
      ...Object.keys(overlaysRef.current).filter(
        (nodeId) => overlaysRef.current[nodeId]?.workflowCheckIssues !== undefined
      )
    ]);
    nodeIds.forEach((nodeId) => {
      const nextIssues = issueMap[nodeId]?.length ? issueMap[nodeId] : undefined;
      if (nextIssues) nextStore[nodeId] = nextIssues;

      const current = overlaysRef.current[nodeId]?.workflowCheckIssues;
      if (JSON.stringify(current ?? undefined) === JSON.stringify(nextIssues)) return;
      patches.push({ nodeId, values: { workflowCheckIssues: nextIssues } });
    });
    issuesRef.current = nextStore;
    patchViewData(patches);
  });

  const clearIssues = useMemoizedFn(() => {
    issuesRef.current = {};
    const patches = Object.entries(overlaysRef.current)
      .filter(([, values]) => values?.workflowCheckIssues !== undefined)
      .map<ViewOverlayPatch>(([nodeId]) => ({
        nodeId,
        values: { workflowCheckIssues: undefined }
      }));
    patchViewData(patches);
  });

  // 语言切换会让模板物化结果失效，扫描侧投影缓存整体作废。
  useEffect(() => {
    scanProjectionCache.current = createProjectionCache();
  }, [t]);

  /**
   * 编辑页定时全量扫描，主动发现新增/已修复的节点问题。
   * 节点与边读文档投影（不带 overlay 与交互状态），与画布校验用的是同一份节点形状；
   * 连线与单节点编辑的即时复查由渲染层防抖路径负责，这里只保底。
   */
  useEffect(() => {
    if (!runtime) return;
    let active = true;

    const runScheduledCheck = async () => {
      const current = runtimeRef.current;
      if (!current || current.isDisposed()) return;
      const { nodes, edges } = projectRuntimeCanvas({
        runtime: current,
        overlays: EMPTY_OVERLAYS,
        t,
        localNodes: [],
        localEdges: [],
        cache: scanProjectionCache.current
      });
      if (nodes.length === 0) return;

      const revision = current.getSavepoint().contentRevision;
      const models = await getWorkflowModelDetails(nodes).catch(() => undefined);
      // 目录失败保留原校验结果；等待期间用户继续编辑则丢弃本轮，避免回写过期结论。
      if (!active || !models || current.isDisposed()) return;
      if (current.getSavepoint().contentRevision !== revision) return;

      syncIssues(checkWorkflowNodeIssues({ nodes, edges, models, t }));
    };

    runScheduledCheck();
    const timer = window.setInterval(runScheduledCheck, ENVIRONMENT_SCAN_INTERVAL);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runtime, syncIssues, t]);

  // 本地草稿、beforeunload 与卸载自动保存、鉴权过期草稿。
  const { authExpiredModal } = useWorkflowDraftLifecycle({
    isSaved,
    serializeWorkflow,
    leaveSaveSign
  });

  // 必须声明在草稿生命周期之后：卸载清理按声明顺序执行，自动保存要先于 Runtime 释放。
  useEffect(
    () => () => {
      teardownRuntime();
    },
    [teardownRuntime]
  );

  const value = useMemo(
    () => ({
      runtime,
      runtimeTick,
      overlaysRef,
      patchViewData,
      undo,
      redo,
      canUndo: history?.canUndo ?? false,
      canRedo: history?.canRedo ?? false,
      versions,
      switchVersion,
      switchCloudVersion,
      isSaved,
      leaveSaveSign,
      serializeWorkflow,
      markSaved,
      issuesRef,
      syncIssues,
      setNodeIssues,
      clearIssues,
      initRuntime,
      loadDocument
    }),
    [
      runtime,
      runtimeTick,
      patchViewData,
      undo,
      redo,
      history?.canUndo,
      history?.canRedo,
      versions,
      switchVersion,
      switchCloudVersion,
      isSaved,
      serializeWorkflow,
      markSaved,
      syncIssues,
      setNodeIssues,
      clearIssues,
      initRuntime,
      loadDocument
    ]
  );

  return (
    <WorkflowHostContext.Provider value={value}>
      <WorkflowEditorProvider runtime={runtime}>
        {children}
        {authExpiredModal}
      </WorkflowEditorProvider>
    </WorkflowHostContext.Provider>
  );
};
