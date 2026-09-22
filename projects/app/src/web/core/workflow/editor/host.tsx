/**
 * 工作流编辑器 host 层：编辑器唯一的数据与生命周期边界。
 *
 * 拥有 Runtime 生命周期与 adapter 挂载、版本列表与整文档替换切换、Savepoint 与出站序列化入口、
 * Issue Provider 注入（与文档检查合并成 Unified Issue View）、Environment Issue 定时扫描与
 * 按节点问题存储（含标红焦点与定位）、本地草稿与离开保护。
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
import { useReactFlow, type Edge } from 'reactflow';
import { createContext, useContextSelector } from 'use-context-selector';
import { formatTime2YMDHMS } from '@fastgpt/global/common/string/time';
import { AppChatConfigTypeSchema } from '@fastgpt/global/core/app/type';
import type { AppVersionSchemaType } from '@fastgpt/global/core/app/version/type';
import {
  hydrateWorkflowEditor,
  type StoreWorkflow
} from '@fastgpt/global/core/workflow/editor/protocol';
import type { WorkflowRuntimePort } from '@fastgpt/global/core/workflow/editor/types';
import type { CanonicalWorkflowData } from '@fastgpt/global/core/workflow/migration';
import type { WorkflowCheckNodeIssueMap } from '@fastgpt/global/core/workflow/type/node';
import { useWorkflowDraftLifecycle } from '@/web/core/workflow/localDraft/useWorkflowDraftLifecycle';
import { useToast } from '@fastgpt/web/hooks/useToast';
import { getWorkflowModelDetails, peekWorkflowModelDetails } from '@/web/core/workflow/modelData';
import {
  checkWorkflowBeforeRunOrPublish,
  checkWorkflowNodeIssues
} from '@/web/core/workflow/workflowCheck';
import { useSystemStore } from '@/web/common/system/useSystemStore';
import { useUserStore } from '@/web/support/user/useUserStore';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import { AppContext } from '@/pageComponents/app/detail/context';
import { materializeWorkflow, serializeRuntime } from './codec';
import { createWorkflowIssueProvider } from './issueProvider';
import { createProjectionCache, projectRuntimeCanvas, type ViewDataOverlayMap } from './projection';
import type { ViewOverlayPatch } from './canvas';
import { WorkflowEditorProvider } from './react';

/** Environment Issue 定时扫描间隔。 */
const ENVIRONMENT_SCAN_INTERVAL = 10_000;
/** 定位问题节点时的视口留白，与画布其它 fitView 调用一致。 */
const ISSUE_FOCUS_FIT_PADDING = 0.3;
/** Runtime 最多保留 100 笔 history；版本列表包含当前状态，因此最多 101 项。 */
const MAX_VERSION_ENTRIES = 101;

/** 扫描用空 overlay：问题检查只读文档投影，不受视图数据影响。 */
const EMPTY_OVERLAYS: ViewDataOverlayMap = {};
/** 扫描用空问题存储：扫描自身就是问题来源，不能把上一轮结果再合并回节点。 */
const EMPTY_ISSUES: WorkflowCheckNodeIssueMap = {};

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
  /** 保存、发布、调试共用的 host 校验与序列化 gate。 */
  serializeWorkflowAndCheck: (hideTip?: boolean) => Promise<StoreWorkflow | undefined>;
  /** 保存成功后回填 Savepoint；失败不调用即不回填，请求期间的新编辑仍算未保存。 */
  markSaved: () => void;

  /** 按节点问题存储：定时扫描、保存/发布 gate、单节点复查写同一份，投影据此渲染问题文案。 */
  issuesRef: MutableRefObject<WorkflowCheckNodeIssueMap>;
  /** 问题焦点节点 id：投影据此标红并选中该节点；undefined 表示无焦点。 */
  issueFocusRef: MutableRefObject<string | undefined>;
  /** 全量覆盖问题存储，map 外的旧问题一并清除；内容未变的节点沿用旧数组身份。 */
  syncIssues: (issueMap: WorkflowCheckNodeIssueMap) => void;
  /** 单节点问题复查：模板新增节点后立即取问题文案，不等定时扫描。 */
  refreshNodeIssues: (nodeId: string) => void;
  /** 清空问题存储与焦点标红（保存/发布/调试 gate 校验通过时调用）。 */
  clearIssues: () => void;
  /** 标红并定位到指定节点；传 undefined 只清除标红（节点被点击或取消选中）。 */
  focusIssueNode: (nodeId?: string) => void;

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
  serializeWorkflowAndCheck: notImplemented,
  markSaved: notImplemented,
  issuesRef: { current: {} },
  issueFocusRef: { current: undefined },
  syncIssues: notImplemented,
  clearIssues: notImplemented,
  refreshNodeIssues: notImplemented,
  focusIssueNode: notImplemented,
  initRuntime: notImplemented,
  loadDocument: notImplemented
});

/**
 * 编辑器 host Provider：挂在 ReactFlowProvider 内、renderer 之上。
 * Runtime 为 null（尚未 hydrate）时不挂 adapter，其余编辑器状态照常供给。
 */
export const WorkflowHostProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  // host 在 ReactFlowProvider 内，问题焦点定位直接用画布视口 API。
  const { fitView } = useReactFlow();
  const setAppDetail = useContextSelector(AppContext, (v) => v.setAppDetail);
  const appDetailChatConfig = useContextSelector(AppContext, (v) => v.appDetail.chatConfig);
  const { feConfigs } = useSystemStore();
  const { teamPlanStatus } = useUserStore();
  const showSandbox = feConfigs?.show_agent_sandbox;
  const enableSandbox = !teamPlanStatus?.standard || !!teamPlanStatus?.standard?.enableSandbox;

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
  const issueFocusRef = useRef<string | undefined>(undefined);
  // 扫描用的独立投影缓存：与画布投影的 overlay/交互状态不同，不能共用。
  const scanProjectionCache = useRef(createProjectionCache());
  // 订阅回调里回写 appDetail，用 ref 避免 chatConfig 变化导致重新订阅。
  const setAppDetailRef = useRef(setAppDetail);
  useEffect(() => {
    setAppDetailRef.current = setAppDetail;
  }, [setAppDetail]);

  // Issue Provider 由 Runtime 同步调用，文案函数走 ref 后绑定：语言切换不需要重建 Runtime。
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

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
        const nextConfig = AppChatConfigTypeSchema.parse(next.getWorkflow().chatConfig);
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

  /**
   * 全量覆盖问题存储：新 map 外的旧问题一并清除（定时扫描与保存/发布 gate 共用）。
   * 内容未变的节点沿用旧数组身份，投影的按节点缓存才不会每轮扫描整表失效。
   */
  const syncIssues = useMemoizedFn((issueMap: WorkflowCheckNodeIssueMap) => {
    const prevStore = issuesRef.current;
    const nextStore: WorkflowCheckNodeIssueMap = {};
    let changed = Object.keys(prevStore).some((nodeId) => !issueMap[nodeId]?.length);

    Object.entries(issueMap).forEach(([nodeId, issues]) => {
      if (!issues?.length) return;
      const prevIssues = prevStore[nodeId];
      const reused =
        prevIssues && JSON.stringify(prevIssues) === JSON.stringify(issues) ? prevIssues : issues;
      if (reused !== prevIssues) changed = true;
      nextStore[nodeId] = reused;
    });

    issuesRef.current = nextStore;
    if (changed) bump();
  });

  /** 清空问题存储与焦点标红；选中态随焦点标记一起由投影还原成本地交互值。 */
  const clearIssues = useMemoizedFn(() => {
    const hadIssues = Object.keys(issuesRef.current).length > 0;
    const hadFocus = issueFocusRef.current !== undefined;
    issuesRef.current = {};
    issueFocusRef.current = undefined;
    if (hadIssues || hadFocus) bump();
  });

  /**
   * 问题焦点：标红哪个节点由 host 单点持有（旧行为同一时刻只标红一个），投影合并进节点 data。
   * 传入 nodeId 时同时 fitView 定位，保存/发布 gate 与调试入口共用；传 undefined 只清除标红，
   * 用于节点被点击或取消选中的场景，此时不应移动视口。
   */
  const focusIssueNode = useMemoizedFn((nodeId?: string) => {
    if (issueFocusRef.current !== nodeId) {
      issueFocusRef.current = nodeId;
      bump();
    }
    if (nodeId) fitView({ nodes: [{ id: nodeId }], padding: ISSUE_FOCUS_FIT_PADDING });
  });

  const serializeWorkflow = useMemoizedFn((): StoreWorkflow | undefined => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) return undefined;
    pendingSaveRevision.current = current.getSavepoint().contentRevision;
    return serializeRuntime(current);
  });

  /**
   * 在保存、发布或调试前从 Runtime 快照执行 sandbox、模型目录和工作流规则校验。
   * 校验失败只更新 host 问题状态与焦点，不序列化不完整文档；hideTip 用于静默预检。
   */
  const serializeWorkflowAndCheck = useMemoizedFn(async (hideTip = false) => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) return undefined;
    const workflow = current.getWorkflow();
    const sandboxNode = workflow.nodes.find((node) => {
      if (
        node.flowNodeType !== FlowNodeTypeEnum.agent &&
        node.flowNodeType !== FlowNodeTypeEnum.toolCall
      )
        return false;
      const enabled = node.inputs.find(
        (input) => input.key === NodeInputKeyEnum.useAgentSandbox
      )?.value;
      return !!enabled && (!showSandbox || !enableSandbox);
    });
    if (sandboxNode) {
      if (!hideTip) {
        focusIssueNode(sandboxNode.nodeId);
        toast({
          status: 'warning',
          title: !showSandbox
            ? t('skill:sandbox_system_not_configured_toast')
            : t('app:sandbox_free_not_support')
        });
      }
      return undefined;
    }
    const nodes = projectRuntimeCanvas({
      runtime: current,
      overlays: EMPTY_OVERLAYS,
      issues: EMPTY_ISSUES,
      t,
      localNodes: [],
      localEdges: [],
      cache: scanProjectionCache.current
    }).nodes;
    const models = await getWorkflowModelDetails(nodes, appDetailChatConfig).catch(() => undefined);
    if (!models) {
      if (!hideTip) toast({ status: 'error', title: t('common:model_catalog_load_failed') });
      return undefined;
    }
    const edges: Edge[] = workflow.edges.map((edge, index) => ({
      id: `wfedge-${index}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle
    }));
    const result = checkWorkflowBeforeRunOrPublish({
      nodes,
      edges,
      models,
      chatConfig: appDetailChatConfig,
      t
    });
    if (result.hasError) {
      if (!hideTip) {
        syncIssues(result.issueMap);
        if (result.firstErrorNodeId) focusIssueNode(result.firstErrorNodeId);
        toast({
          status: 'warning',
          title: t('common:core.workflow.Check Failed'),
          description: [...Object.values(result.issueMap).flat(), ...result.chatConfigIssues]
            .filter((issue) => issue.level === 'error')
            .map((issue) => issue.message)
            .filter(Boolean)
            .join('\n')
        });
      }
      return undefined;
    }
    clearIssues();
    return serializeWorkflow();
  });

  const markSaved = useMemoizedFn(() => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) return;
    const revision = pendingSaveRevision.current ?? current.getSavepoint().contentRevision;
    pendingSaveRevision.current = undefined;
    current.markSaved(revision);
    bump();
  });

  /** 文档整体替换（初始化、导入、版本切换）后，上一份文档的问题与标红焦点一律作废。 */
  const resetIssueState = useMemoizedFn(() => {
    issuesRef.current = {};
    issueFocusRef.current = undefined;
  });

  const initRuntime = useMemoizedFn((content: CanonicalWorkflowData) => {
    // provider 结果与文档检查合并成 Unified Issue View；Workflow 与 Plugin host 共用这一份接线。
    const nextRuntime = hydrateWorkflowEditor(content, {
      issueProvider: createWorkflowIssueProvider({
        getModels: peekWorkflowModelDetails,
        getT: () => tRef.current
      })
    });
    attachRuntime(nextRuntime);
    overlaysRef.current = {};
    resetIssueState();
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
    resetIssueState();
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
        const liveIndex = versionsRef.current.findIndex((item) => item.live);
        if (liveIndex < 0) return false;
        const direction = targetIndex > liveIndex ? 'undo' : 'redo';
        const res = current.replayHistory(direction, Math.abs(targetIndex - liveIndex));
        if (!res.ok || current.getSavepoint().contentRevision !== entry.contentRevision)
          return false;
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
      resetIssueState();
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

  /**
   * 扫描文档投影并写入问题存储：定时全量扫描与单节点复查共用同一条写入路径。
   * 节点与边读文档投影（不带 overlay、问题与交互状态），与画布校验用的是同一份节点形状；
   * 指定 nodeId 时只复查该节点，模型目录也只取该节点所需。
   * 目录失败保留原校验结果；等待期间文档已变更则丢弃本轮，避免回写过期结论。
   */
  const scanIssues = useMemoizedFn(async (nodeId?: string) => {
    const current = runtimeRef.current;
    if (!current || current.isDisposed()) return;
    const { nodes, edges } = projectRuntimeCanvas({
      runtime: current,
      overlays: EMPTY_OVERLAYS,
      issues: EMPTY_ISSUES,
      t,
      localNodes: [],
      localEdges: [],
      cache: scanProjectionCache.current
    });
    if (nodes.length === 0) return;

    const targetNodes = nodeId ? nodes.filter((node) => node.id === nodeId) : nodes;
    const revision = current.getSavepoint().contentRevision;
    const models = await getWorkflowModelDetails(targetNodes).catch(() => undefined);
    if (!models || current.isDisposed()) return;
    if (current.getSavepoint().contentRevision !== revision) return;

    const issueMap = checkWorkflowNodeIssues({
      nodes,
      edges,
      models,
      nodeIds: nodeId ? [nodeId] : undefined,
      t
    });
    if (!nodeId) {
      syncIssues(issueMap);
      return;
    }

    // 单节点复查：问题存储是投影的唯一读取源，写入后必须 bump 才会重投影；
    // 内容一致时不 bump，避免节点组件每轮复查都重渲染。
    const nextIssues = issueMap[nodeId]?.length ? issueMap[nodeId] : undefined;
    const prevIssues = issuesRef.current[nodeId];
    if (nextIssues === undefined && prevIssues === undefined) return;
    if (nextIssues && prevIssues && JSON.stringify(nextIssues) === JSON.stringify(prevIssues)) {
      return;
    }
    const nextStore = { ...issuesRef.current };
    if (nextIssues) nextStore[nodeId] = nextIssues;
    else delete nextStore[nodeId];
    issuesRef.current = nextStore;
    bump();
  });

  /** 单节点问题复查入口：模板新增节点后立即取问题文案，不等定时扫描。 */
  const refreshNodeIssues = useMemoizedFn((nodeId: string) => {
    if (!nodeId) return;
    void scanIssues(nodeId);
  });

  /**
   * 编辑页定时全量扫描，主动发现新增/已修复的节点问题。
   * 节点配置编辑后的即时复查已随旧 Actions 防抖路径删除，问题文案最迟在一轮扫描内刷新。
   * t 是刻意的依赖：语言切换会让模板物化结果与问题文案一起失效，
   * 因此扫描侧投影缓存整体作废并立即重扫一轮，不等下一个定时周期。
   */
  useEffect(() => {
    if (!runtime) return;
    scanProjectionCache.current = createProjectionCache();
    void scanIssues();
    const timer = window.setInterval(() => void scanIssues(), ENVIRONMENT_SCAN_INTERVAL);

    return () => {
      window.clearInterval(timer);
    };
  }, [runtime, scanIssues, t]);

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
      serializeWorkflowAndCheck,
      markSaved,
      issuesRef,
      issueFocusRef,
      syncIssues,
      clearIssues,
      refreshNodeIssues,
      focusIssueNode,
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
      serializeWorkflowAndCheck,
      markSaved,
      syncIssues,
      clearIssues,
      refreshNodeIssues,
      focusIssueNode,
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
