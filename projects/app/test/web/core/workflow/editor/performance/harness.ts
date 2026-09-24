/**
 * 重渲染断言 harness：真实 Provider 树 + 计数型叶子消费者，不挂 ReactFlow 画布。
 *
 * 为什么不用真实 `WorkflowHostProvider`：它会拖进 next-i18next、system/user store、
 * 本地草稿生命周期与模型目录加载，这些都不是被测对象。这里用一个最小 host 复刻它对
 * `WorkflowHostContext` 的契约（Runtime 生命周期 + 一个视图计数器 + overlay + 标红焦点），
 * 其下挂真实的 canvas / UI / selection / debug context 与 adapter provider。
 *
 * `ReactFlowProvider` 必须挂（host 侧用 `useReactFlow().fitView`），但不挂 `<ReactFlow>`：
 * 视口相关的「平移缩放」交互改由 `viewport-static.test.ts` 的静态断言覆盖。
 *
 * DOM 环境沿用仓库既有模式（见 `test/web/core/workflow/editor/host.test.ts`）：node 环境 +
 * 手工 `new JSDOM(...)` + `vi.stubGlobal`。不用 `// @vitest-environment jsdom` 文档块，因为
 * `test/setup.ts` 会加载 `packages/service/env.ts`，而 t3-env 把「存在 window」判成客户端，
 * 模块作用域读服务端变量会直接抛错。
 */
import React, { Profiler, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useMemoizedFn } from 'ahooks';
import { vi } from 'vitest';
import { ReactFlowProvider, useReactFlow } from 'reactflow';
import { useContextSelector } from 'use-context-selector';
import type { Edge, NodeChange } from 'reactflow';
import { hydrateWorkflowEditor } from '@fastgpt/global/core/workflow/editor/protocol';
import type {
  WorkflowEnvironment,
  WorkflowRuntimePort
} from '@fastgpt/global/core/workflow/editor/types';
import type { AppDetailType } from '@fastgpt/global/core/app/type';
import { defaultApp } from '@/web/core/app/constants';
import { WorkflowEditorProvider, useCanvas } from '@/web/core/workflow/editor';
import type { CanvasNode, ViewOverlayPatch } from '@/web/core/workflow/editor/canvas';
import {
  WorkflowHostContext,
  type WorkflowHostValue,
  type WorkflowVersionEntry
} from '@/web/core/workflow/editor/host';
import type { ViewDataOverlayMap } from '@/web/core/workflow/editor/projection';
import { AppContext, TabEnum } from '@/pageComponents/app/detail/context';
import { WorkflowDebugProvider } from '@/pageComponents/app/detail/WorkflowComponents/context/workflowDebugContext';
import WorkflowCanvasProvider, {
  WorkflowCanvasContext
} from '@/pageComponents/app/detail/WorkflowComponents/Flow/context/workflowCanvasContext';
import { WorkflowSelectionProvider } from '@/pageComponents/app/detail/WorkflowComponents/Flow/context/workflowSelectionContext';
import {
  WorkflowUIContext,
  WorkflowUIProvider,
  type ConnectingEdgeState
} from '@/pageComponents/app/detail/WorkflowComponents/Flow/context/workflowUIContext';
import type { FixtureWorkflow } from './fixtures';
import {
  buildLeafSpecs,
  createLeafRegistry,
  LeafRegistryContext,
  type LeafRegistry
} from './leaves';

const notWired = (): never => {
  throw new Error('workflow harness: this host entry is not wired');
};

/**
 * 挂一个 Provider：children 走 `createElement` 的第三参（eslint 的 `react/no-children-prop`
 * 禁止放进 props），而生产 Provider 大多把 `children` 声明成必填 props，直接传第三参又匹配不到
 * 重载。这里把类型上的 `children` 摘掉，两个约束同时满足，运行期行为与 JSX 完全一致。
 */
const mountProvider = <P extends object>(
  Component: React.ComponentType<P>,
  props: Omit<P, 'children'>,
  children: React.ReactNode
) => React.createElement(Component as React.ComponentType<Omit<P, 'children'>>, props, children);

/** host context 的 Provider 单独处理：value 里带 ref，经过自定义函数传参会被 react-hooks/refs */
/** 判成渲染期读 ref，只有 React.createElement 这条路径不被拦。类型上摘掉必填的 children。 */
const HostContextProvider = WorkflowHostContext.Provider as React.ComponentType<{
  value: WorkflowHostValue;
  children?: React.ReactNode;
}>;

/**
 * 安装最小 DOM：每个测试文件在 `beforeEach` 调用，`afterEach` 调 `vi.unstubAllGlobals()`。
 * jsdom 已是 `projects/app` 的 devDependency，不新增依赖。
 */
export const installHarnessDom = () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/'
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  // vitest 用经典 JSX 运行时转换 .tsx，而部分生产组件（如 workflowRuntimeContext）不显式
  // import React，渲染时会 ReferenceError。挂真实 Provider 树必须补上这个全局。
  vi.stubGlobal('React', React);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame);
  const reactGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  reactGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
};

/** 可翻转的环境事实：`refresh-issues` 交互靠它制造「文档没变但 Issue View 全变」。 */
export type HarnessEnvironment = {
  sandboxConfigured: boolean;
};

type TestHostProps = {
  runtime: WorkflowRuntimePort;
  children: React.ReactNode;
};

/**
 * 最小 host：复刻生产 host 对 `WorkflowHostContext` 的契约，含 06a-7 之后的通道划分。
 *
 * `viewTick` 只承载 renderer view 通道（overlay 写入与标红焦点）；runtime 事件（语义与几何）
 * 与 `markSaved` 走不进 context value 的 `notifyHost`，只让 host 自己重算 canUndo/canRedo/isSaved。
 * 语义派生吃 `runtime.getWorkflow()` 的快照身份，几何由画布 provider 自己订阅 runtime，
 * 所以叶子的重渲染行为自动跟随生产实现变化，通道调整不需要动 harness。
 */
const TestWorkflowHostProvider = ({ runtime, children }: TestHostProps) => {
  const { fitView } = useReactFlow();
  const [viewTick, setViewTick] = useState(0);
  const overlaysRef = useRef<ViewDataOverlayMap>({});
  const issueFocusRef = useRef<string | undefined>(undefined);
  const [, notifyHost] = useReducer((count: number) => count + 1, 0);

  const bumpView = useMemoizedFn(() => setViewTick((tick) => tick + 1));

  useEffect(() => runtime.subscribe(notifyHost), [runtime, notifyHost]);

  const patchViewData = useMemoizedFn((patches: ViewOverlayPatch[]) => {
    if (patches.length === 0) return;
    const next = { ...overlaysRef.current };
    patches.forEach(({ nodeId, values }) => {
      next[nodeId] = { ...next[nodeId], ...values };
    });
    overlaysRef.current = next;
    bumpView();
  });

  const focusIssueNode = useMemoizedFn((nodeId?: string) => {
    if (issueFocusRef.current !== nodeId) {
      issueFocusRef.current = nodeId;
      bumpView();
    }
    if (nodeId) fitView({ nodes: [{ id: nodeId }], padding: 0.3 });
  });

  const undo = useMemoizedFn(() => runtime.undo());
  const redo = useMemoizedFn(() => runtime.redo());
  const markSaved = useMemoizedFn(() => {
    runtime.markSaved(runtime.getSavepoint().contentRevision);
    // 只影响 isSaved，画布投影不读保存态，不动视图计数器（与生产 host 一致）。
    notifyHost();
  });

  const history = runtime.getHistory();
  const isSaved = !runtime.getSavepoint().isDirty;

  const value = useMemo<WorkflowHostValue>(
    () => ({
      runtime,
      viewTick,
      overlaysRef,
      patchViewData,
      undo,
      redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      versions: [] as WorkflowVersionEntry[],
      switchVersion: notWired,
      switchCloudVersion: notWired,
      isSaved,
      leaveSaveSign: { current: true },
      serializeWorkflow: notWired,
      serializeWorkflowAndCheck: notWired,
      markSaved,
      issueFocusRef,
      focusIssueNode,
      initRuntime: notWired,
      loadDocument: notWired
    }),
    [
      runtime,
      viewTick,
      patchViewData,
      undo,
      redo,
      history.canUndo,
      history.canRedo,
      isSaved,
      markSaved,
      focusIssueNode
    ]
  );

  return React.createElement(
    HostContextProvider,
    { value },
    mountProvider(WorkflowEditorProvider, { runtime }, children)
  );
};

/** 驱动交互需要的外部句柄；每帧从真实 context 里取，保证测的是生产接线。 */
export type HarnessControls = {
  runtime: WorkflowRuntimePort;
  environment: HarnessEnvironment;
  setHoverNodeId: (nodeId?: string) => void;
  setHoverEdgeId: (edgeId?: string) => void;
  setConnectingEdge: (state?: ConnectingEdgeState) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  commitGeometry: ReturnType<typeof useCanvas>['commitGeometry'];
  patchViewData: (patches: ViewOverlayPatch[]) => void;
  focusIssueNode: (nodeId?: string) => void;
  undo: () => void;
  redo: () => void;
  nodes: CanvasNode[];
  edges: Edge<any>[];
};

type ControlsProbeProps = {
  runtime: WorkflowRuntimePort;
  environment: HarnessEnvironment;
  /** 把当前句柄发布到 harness 闭包；组件内部不持有可变对象，避开 props 不可变约束。 */
  publish: (controls: HarnessControls) => void;
};

/**
 * 非计数探针：把真实 context 上的驱动句柄与当前画布数组发布出去。
 * 用无依赖数组的 effect，每次 commit 后刷新，`act` 结束即可读到最新值。
 */
const ControlsProbe = ({ runtime, environment, publish }: ControlsProbeProps) => {
  const setHoverNodeId = useContextSelector(WorkflowUIContext, (v) => v.setHoverNodeId);
  const setHoverEdgeId = useContextSelector(WorkflowUIContext, (v) => v.setHoverEdgeId);
  const setConnectingEdge = useContextSelector(WorkflowUIContext, (v) => v.setConnectingEdge);
  const onNodesChange = useContextSelector(WorkflowCanvasContext, (v) => v.onNodesChange);
  const nodes = useContextSelector(WorkflowCanvasContext, (v) => v.nodes);
  const edges = useContextSelector(WorkflowCanvasContext, (v) => v.edges);
  const patchViewData = useContextSelector(WorkflowHostContext, (v) => v.patchViewData);
  const focusIssueNode = useContextSelector(WorkflowHostContext, (v) => v.focusIssueNode);
  const undo = useContextSelector(WorkflowHostContext, (v) => v.undo);
  const redo = useContextSelector(WorkflowHostContext, (v) => v.redo);
  const { commitGeometry } = useCanvas();

  useEffect(() => {
    publish({
      runtime,
      environment,
      setHoverNodeId,
      setHoverEdgeId,
      setConnectingEdge,
      onNodesChange,
      commitGeometry,
      patchViewData,
      focusIssueNode,
      undo,
      redo,
      nodes,
      edges
    });
  });

  return null;
};

export type EditorHarness = {
  runtime: WorkflowRuntimePort;
  registry: LeafRegistry;
  controls: () => HarnessControls;
  unmount: () => Promise<void>;
};

export type MountHarnessOptions = {
  workflow: FixtureWorkflow;
  /** 大规模 fixture 只给前 N 个节点挂每节点叶子；缺省全量。 */
  perNodeLimit?: number;
};

/**
 * 挂载真实 Provider 树并返回驱动句柄。
 * 树的嵌套顺序与生产一致（AppContext > ReactFlowProvider > host > canvas > debug > UI > selection）。
 */
export const mountEditorHarness = async ({
  workflow,
  perNodeLimit
}: MountHarnessOptions): Promise<EditorHarness> => {
  const environment: HarnessEnvironment = { sandboxConfigured: false };
  const getEnvironment = (): WorkflowEnvironment => ({
    sandbox: { configured: environment.sandboxConfigured, planSupported: true }
  });
  const runtime = hydrateWorkflowEditor(workflow as never, { getEnvironment });

  const registry = createLeafRegistry();
  const leafSpecs = buildLeafSpecs({ runtime, perNodeLimit });
  // appId 留空：WorkflowUIProvider 的演示模式埋点因此完全不启动。
  const appDetail: AppDetailType = { ...defaultApp, _id: '' };
  const appContextValue = {
    appId: '',
    currentTab: TabEnum.appEdit,
    route2Tab: notWired,
    appDetail,
    setAppDetail: notWired,
    loadingApp: false,
    updateAppDetail: notWired,
    onOpenInfoEdit: notWired,
    onDelApp: notWired,
    onSaveApp: notWired,
    appLatestVersion: undefined,
    reloadAppLatestVersion: notWired,
    reloadApp: notWired
  };

  const box = { current: undefined as unknown as HarnessControls };
  const publish = (controls: HarnessControls) => {
    box.current = controls;
  };
  const leaves = leafSpecs.map(({ label, element }) => React.cloneElement(element, { key: label }));

  const leafTree = mountProvider(
    LeafRegistryContext.Provider,
    { value: registry },
    React.createElement(
      Profiler,
      { id: 'workflow-harness', onRender: () => registry.recordCommit() },
      React.createElement(ControlsProbe, { runtime, environment, publish }),
      ...leaves
    )
  );
  const tree = mountProvider(
    AppContext.Provider,
    { value: appContextValue as never },
    React.createElement(
      ReactFlowProvider,
      null,
      mountProvider(
        TestWorkflowHostProvider,
        { runtime },
        mountProvider(
          WorkflowCanvasProvider,
          {},
          mountProvider(
            WorkflowDebugProvider,
            {},
            mountProvider(
              WorkflowUIProvider,
              {},
              mountProvider(WorkflowSelectionProvider, {}, leafTree)
            )
          )
        )
      )
    )
  );

  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(tree);
  });

  return {
    runtime,
    registry,
    controls: () => box.current,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      if (!runtime.isDisposed()) runtime.dispose();
    }
  };
};

// ---------------------------------------------------------------------------
// 交互执行与两组数据
// ---------------------------------------------------------------------------

export type InteractionStep = (harness: EditorHarness) => void;

export type InteractionSpec = {
  name: string;
  /** 不计入测量的前置写入（例如 undo/redo 之前先造一笔历史）。 */
  setup?: InteractionStep;
  steps: InteractionStep[];
};

export type InteractionSample = {
  /** 叶子组件函数执行次数（各步求和）。含 use-context-selector 的无效重跑，只进基线表。 */
  renders: number;
  /** Profiler commit 次数（各步求和）。 */
  commits: number;
  /** 观察到新 snapshot 的标签集合（各步 union）。允许集合断言的对象。 */
  changedLabels: string[];
  /** 组件函数跑过的标签集合（各步 union）。诊断用。 */
  renderedLabels: string[];
  identityNodes: number;
  identityEdges: number;
};

const countIdentityChanges = <T extends { id: string }>(before: T[], after: T[]) => {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  let changed = 0;
  new Set([...beforeById.keys(), ...afterById.keys()]).forEach((id) => {
    if (beforeById.get(id) !== afterById.get(id)) changed += 1;
  });
  return changed;
};

/**
 * 跑一个交互，产出两组数据：
 * (i) 重渲染标签集合（观察到新 snapshot 的标签，各步 union）；
 * (ii) 投影后身份变化的节点数与边数（各步求和）。
 * render / commit 次数同样是各步求和；`setup` 的写入不计入任何一项。
 */
export const runInteraction = async (
  harness: EditorHarness,
  spec: InteractionSpec
): Promise<InteractionSample> => {
  const { registry } = harness;

  if (spec.setup) {
    await act(async () => {
      spec.setup!(harness);
    });
  }

  const changedLabels = new Set<string>();
  const renderedLabels = new Set<string>();
  let renders = 0;
  let commits = 0;
  let identityNodes = 0;
  let identityEdges = 0;

  for (const step of spec.steps) {
    const changesBefore = registry.changedSnapshot();
    const renderedBefore = registry.renderedSnapshot();
    const rendersBefore = registry.renderTotal;
    const commitsBefore = registry.commits;
    const nodesBefore = harness.controls().nodes;
    const edgesBefore = harness.controls().edges;

    await act(async () => {
      step(harness);
    });

    registry.changes.forEach((count, label) => {
      if (count !== changesBefore.get(label)) changedLabels.add(label);
    });
    registry.renders.forEach((count, label) => {
      if (count !== renderedBefore.get(label)) renderedLabels.add(label);
    });
    renders += registry.renderTotal - rendersBefore;
    commits += registry.commits - commitsBefore;
    identityNodes += countIdentityChanges(nodesBefore, harness.controls().nodes);
    identityEdges += countIdentityChanges(edgesBefore, harness.controls().edges);
  }

  return {
    renders,
    commits,
    changedLabels: [...changedLabels].sort(),
    renderedLabels: [...renderedLabels].sort(),
    identityNodes,
    identityEdges
  };
};
