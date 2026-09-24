/**
 * 计数型叶子消费者：每个叶子按稳定标签注册，内部用与生产组件相同的形状读取，
 * 并把「本次渲染观察到的值」与上一次比较，身份变了才计数。
 *
 * ## 为什么计数的是「观察到的值变了」而不是「组件函数又跑了一次」
 *
 * React 18.3.1 的 `dispatchReducerAction` 没有 eager bail-out（只有 `dispatchSetState` 有），
 * 而 `use-context-selector@1.4.4` 的 `useContextSelector` 正是用 `useReducer` 接通知：
 * provider 值身份一变，每个消费者的组件函数都会跑一次，与 selector 是否命中无关。
 * 但 reducer 在渲染期返回旧 state 时 `didReceiveUpdate` 保持 false，React 会走
 * `bailoutOnAlreadyFinishedWork`，整棵子树不重渲染。
 *
 * 所以 selector 收窄真正省掉的是子树重渲染，剩下的代价只有组件函数本身跑一次。
 * 本 harness 断言的是子树重渲染维度（spec 的「哪些订阅者的 snapshot 返回了新值」）；
 * 组件函数执行次数单独记进 `renders`，只进基线表，不参与允许集合断言。
 *
 * ## 标签是契约
 *
 * 标签在 06a-1 登记时就固定了（例如 `canvas-context-whole`），06a-2..06a-8 收窄生产订阅面时
 * 标签一律不变，所以允许集合断言从红转绿不需要动契约。06a-9 已把当初镜像「改造前内联
 * selector」的叶子全部换成与生产同形的 scoped 读取，标签保留原名（名字里的 `whole` 只反映
 * 登记时的形状，不代表当前读取面）。现在每个叶子都跟随生产实现：生产侧把订阅面写宽，
 * 对应家族会立刻超预算。
 */
import React, { useContext } from 'react';
import { useContextSelector } from 'use-context-selector';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import type { WorkflowRuntimePort } from '@fastgpt/global/core/workflow/editor/types';
import {
  useField,
  useNode,
  usePlacementContext,
  useWorkflow,
  useWorkflowActions,
  useWorkflowValue
} from '@/web/core/workflow/editor';
import { WorkflowDebugContext } from '@/pageComponents/app/detail/WorkflowComponents/context/workflowDebugContext';
import { WorkflowCanvasContext } from '@/pageComponents/app/detail/WorkflowComponents/Flow/context/workflowCanvasContext';
import { WorkflowSelectionContext } from '@/pageComponents/app/detail/WorkflowComponents/Flow/context/workflowSelectionContext';
import { WorkflowUIContext } from '@/pageComponents/app/detail/WorkflowComponents/Flow/context/workflowUIContext';
import {
  useIsToolNode,
  useWorkflowDocument
} from '@/pageComponents/app/detail/WorkflowComponents/Flow/nodes/render/useWorkflowDocument';
import { editableFieldKey } from './fixtures';

// ---------------------------------------------------------------------------
// 计数注册表
// ---------------------------------------------------------------------------

export type LeafRegistry = {
  /** label -> 观察到新值的累计次数（允许集合断言用）。 */
  changes: Map<string, number>;
  /** label -> 组件函数执行的累计次数（基线表用，含 use-context-selector 的无效重跑）。 */
  renders: Map<string, number>;
  /** label -> 上一次观察到的值。挂在 registry 上而不是 useRef，避开渲染期读写 ref。 */
  observed: Map<string, unknown[]>;
  /** 叶子组件函数执行总次数。 */
  renderTotal: number;
  /** Profiler onRender 次数，即整棵子树的 commit 次数。 */
  commits: number;
  recordRender: (label: string) => void;
  /** 记下本次观察到的值；与上一次身份不同才算一次变化。首次只建基线。 */
  recordObserved: (label: string, values: unknown[]) => void;
  recordCommit: () => void;
  changedSnapshot: () => Map<string, number>;
  renderedSnapshot: () => Map<string, number>;
};

const sameObserved = (previous: unknown[], next: unknown[]) =>
  previous.length === next.length &&
  previous.every((value, index) => Object.is(value, next[index]));

export const createLeafRegistry = (): LeafRegistry => {
  const changes = new Map<string, number>();
  const renders = new Map<string, number>();
  const observed = new Map<string, unknown[]>();
  const bump = (map: Map<string, number>, label: string) =>
    map.set(label, (map.get(label) ?? 0) + 1);
  return {
    changes,
    renders,
    observed,
    renderTotal: 0,
    commits: 0,
    recordRender(label) {
      bump(renders, label);
      this.renderTotal += 1;
    },
    recordObserved(label, values) {
      const previous = observed.get(label);
      if (previous !== undefined && sameObserved(previous, values)) return;
      observed.set(label, values);
      // 首次渲染只建基线：挂载本身不算一次「snapshot 变了」。
      if (previous !== undefined) bump(changes, label);
    },
    recordCommit() {
      this.commits += 1;
    },
    changedSnapshot: () => new Map(changes),
    renderedSnapshot: () => new Map(renders)
  };
};

export const LeafRegistryContext = React.createContext<LeafRegistry | null>(null);

/** 渲染期计数：记一次组件函数执行，再把本次观察到的值交给 registry 做身份比较。 */
const useObservedLeaf = (label: string, observed: unknown[]) => {
  const registry = useContext(LeafRegistryContext);
  if (!registry) throw new Error('leaf must be mounted inside LeafRegistryContext');
  registry.recordRender(label);
  registry.recordObserved(label, observed);
};

type LeafProps = { label: string };
type NodeLeafProps = LeafProps & { nodeId: string };

// ---------------------------------------------------------------------------
// 工作流级叶子（adapter 订阅面，06a-5）
// ---------------------------------------------------------------------------

/** 只用写能力的消费点：稳定 action 句柄，订阅数为零，任何交互都不该让观察值变。 */
const CommandOnlyLeaf = ({ label }: LeafProps) => {
  const actions = useWorkflowActions();
  void actions.addNode;
  void actions.removeNodes;
  useObservedLeaf(label, [actions]);
  return null;
};

/**
 * 只在事件回调里读 edges 的消费点（06a-5 B 类的形状）：`getEdges()` 是非订阅 getter，
 * 观察值是这两个 getter 的身份——句柄冻结且不随结构变化重建，所以任何交互都不该让它们变。
 */
const EdgesCallbackOnlyLeaf = ({ label }: LeafProps) => {
  const { getEdges, disconnectEdge } = useWorkflowActions();
  useObservedLeaf(label, [getEdges, disconnectEdge]);
  return null;
};

/** 真正需要结构快照的消费点（`Flow/index.tsx` 把 nodes/edges 交给 ReactFlow）。 */
const StructureReaderLeaf = ({ label }: LeafProps) => {
  const workflow = useWorkflow();
  useObservedLeaf(label, [workflow]);
  return null;
};

/** placement context 消费点（侧边栏模板目录）。 */
const PlacementContextLeaf = ({ label }: LeafProps) => {
  const context = usePlacementContext({ isSidebar: true });
  useObservedLeaf(label, [context]);
  return null;
};

/** 语义派生列表消费点（变量列表、引用选择器）：只按语义快照身份触发。 */
const EdgesReaderLeaf = ({ label }: LeafProps) => {
  const { workflow } = useWorkflowDocument();
  // 语义快照身份就是派生列表唯一的缓存 key：几何提交、overlay 写入与标红焦点都不换它。
  useObservedLeaf(label, [workflow]);
  return null;
};

// ---------------------------------------------------------------------------
// context 级叶子（06a-6）
// ---------------------------------------------------------------------------

/**
 * canvas context 的稳定回调消费点（`Flow/hooks/useWorkflow.tsx` 与 `ContextMenu` 的形状）：
 * 四个字段全是 `useMemoizedFn`，观察值恒定，拖拽帧与重投影都不该让它变。
 */
const CanvasContextFieldsLeaf = ({ label }: LeafProps) => {
  const onNodesChange = useContextSelector(WorkflowCanvasContext, (v) => v.onNodesChange);
  const onEdgesChange = useContextSelector(WorkflowCanvasContext, (v) => v.onEdgesChange);
  const setNodes = useContextSelector(WorkflowCanvasContext, (v) => v.setNodes);
  const getNodes = useContextSelector(WorkflowCanvasContext, (v) => v.getNodes);
  useObservedLeaf(label, [onNodesChange, onEdgesChange, setNodes, getNodes]);
  return null;
};

/**
 * UI context 的稳定字段消费点（`Flow/index.tsx` 的 `WorkflowCanvas` 形状）：
 * 拆字段后观察值只剩这三个，hover 与鼠标进出画布都不该让画布组件重渲染。
 */
const UIContextFieldsLeaf = ({ label }: LeafProps) => {
  const reactFlowWrapperCallback = useContextSelector(
    WorkflowUIContext,
    (v) => v.reactFlowWrapperCallback
  );
  const workflowControlMode = useContextSelector(WorkflowUIContext, (v) => v.workflowControlMode);
  const menu = useContextSelector(WorkflowUIContext, (v) => v.menu);
  useObservedLeaf(label, [reactFlowWrapperCallback, workflowControlMode, menu]);
  return null;
};

const HoverNodeIdLeaf = ({ label }: LeafProps) => {
  const hoverNodeId = useContextSelector(WorkflowUIContext, (v) => v.hoverNodeId);
  useObservedLeaf(label, [hoverNodeId]);
  return null;
};

const HoverEdgeIdLeaf = ({ label }: LeafProps) => {
  const hoverEdgeId = useContextSelector(WorkflowUIContext, (v) => v.hoverEdgeId);
  useObservedLeaf(label, [hoverEdgeId]);
  return null;
};

const SelectedNodesMapLeaf = ({ label }: LeafProps) => {
  const selectedNodesMap = useContextSelector(WorkflowSelectionContext, (v) => v.selectedNodesMap);
  useObservedLeaf(label, [selectedNodesMap]);
  return null;
};

// ---------------------------------------------------------------------------
// 每节点叶子（06a-4）
// ---------------------------------------------------------------------------

/** `NodeCard` 的形状：订阅本节点句柄与父节点（容器折叠时隐藏）。 */
const NodeCardLeaf = ({ label, nodeId }: NodeLeafProps) => {
  const node = useNode(nodeId);
  const parent = useNode(node?.data.parentNodeId ?? '');
  useObservedLeaf(label, [node, parent]);
  return null;
};

/** `useIsToolNode` 是生产 hook，06a-4 换内部实现后本叶子自动跟随。 */
const IsToolNodeLeaf = ({ label, nodeId }: NodeLeafProps) => {
  const isToolNode = useIsToolNode(nodeId);
  useObservedLeaf(label, [isToolNode]);
  return null;
};

/** 单字段订阅。 */
const FieldLeaf = ({ label, nodeId }: NodeLeafProps) => {
  const field = useField({ nodeId, fieldKey: editableFieldKey, kind: 'input' });
  useObservedLeaf(label, [field]);
  return null;
};

/** `MySourceHandle` 的形状：图查询算连通，再叠 hover / 选中 / 连线态，全部是 boolean。 */
const SourceHandleLeaf = ({ label, nodeId }: NodeLeafProps) => {
  const handleId = getHandleId(nodeId, 'source', 'right');
  const connected = useWorkflowValue((_structure, graph) =>
    graph.isHandleConnected({ nodeId, handleId, direction: 'source' })
  );
  const isConnectingSelf = useContextSelector(
    WorkflowUIContext,
    (v) => v.connectingEdge?.handleId === handleId
  );
  const nodeIsHover = useContextSelector(WorkflowUIContext, (v) => v.hoverNodeId === nodeId);
  const selected = useContextSelector(WorkflowSelectionContext, (v) => v.selectedNodesMap[nodeId]);
  const active = nodeIsHover || !!selected || isConnectingSelf;
  useObservedLeaf(label, [connected, active]);
  return null;
};

/** `MyTargetHandle` 的形状：图查询算连通 + 「有没有在拖拽连线」一个事实。 */
const TargetHandleLeaf = ({ label, nodeId }: NodeLeafProps) => {
  const connected = useWorkflowValue((_structure, graph) =>
    graph.isHandleConnected({
      nodeId,
      handleId: getHandleId(nodeId, 'target', 'left'),
      direction: 'target'
    })
  );
  const isConnecting = useContextSelector(WorkflowUIContext, (v) => !!v.connectingEdge);
  useObservedLeaf(label, [connected, isConnecting]);
  return null;
};

/** `ConnectionTargetHandle` 的形状：图查询算禁止连接，观察值只有一个 boolean。 */
const ConnectionTargetLeaf = ({ label, nodeId }: NodeLeafProps) => {
  const connectingHandleId = useContextSelector(
    WorkflowUIContext,
    (v) => v.connectingEdge?.handleId
  );
  const forbidConnect = useWorkflowValue(
    (_structure, graph) =>
      graph.isMountedTool(nodeId) ||
      (!!connectingHandleId &&
        graph.getIncomingEdges(nodeId).some((edge) => edge.sourceHandle === connectingHandleId))
  );
  useObservedLeaf(label, [forbidConnect]);
  return null;
};

// ---------------------------------------------------------------------------
// 每边叶子（06a-4）
// ---------------------------------------------------------------------------

type EdgeLeafProps = LeafProps & { edgeId: string; source: string; target: string };

/** `ButtonEdge` 的形状。 */
const EdgeLeaf = ({ label, edgeId, source, target }: EdgeLeafProps) => {
  const highlight = useContextSelector(
    WorkflowSelectionContext,
    (v) => !!(v.selectedNodesMap[source] || v.selectedNodesMap[target])
  );
  const debugEdgeCount = useContextSelector(
    WorkflowDebugContext,
    (v) => v.workflowDebugData?.runtimeEdges.length ?? 0
  );
  const isHover = useContextSelector(WorkflowUIContext, (v) => v.hoverEdgeId === edgeId);
  // 结构订阅只剩一个用途：结构变了要重算同源边偏移（06 总纲决策 11 的保留项）。
  const structureEdges = useWorkflowValue((structure) => structure.edges);
  const { disconnectEdge } = useWorkflowActions();
  const sourceParentId = useNode(source)?.data.parentNodeId;
  const targetParentId = useNode(target)?.data.parentNodeId;
  const foldParent = useNode(sourceParentId ?? targetParentId ?? '');
  void disconnectEdge;
  useObservedLeaf(label, [highlight, isHover, debugEdgeCount, structureEdges, foldParent]);
  return null;
};

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export type LeafSpec = { label: string; element: React.ReactElement };

/** 标签家族：':' 之前的部分。允许集合按家族 + 实例数写，不写死节点 id 全集。 */
export const leafFamily = (label: string) => label.split(':')[0];

/**
 * 按 runtime 当前文档生成叶子清单：10 个工作流/context 级单例 + 每节点 5~6 个 + 每边 1 个。
 *
 * `perNodeLimit` 用于大规模 fixture 抽样：只给前 N 个节点挂每节点叶子，避免 1000 节点 × 6 个
 * 叶子把 jsdom 挂载时间吃掉；边叶子始终全量，因为边侧订阅是 06a-4 的主要收益面。
 */
export const buildLeafSpecs = ({
  runtime,
  perNodeLimit
}: {
  runtime: WorkflowRuntimePort;
  perNodeLimit?: number;
}): LeafSpec[] => {
  const { nodes, edges } = runtime.getWorkflow();
  const specs: LeafSpec[] = [];

  const singletons: [string, React.ComponentType<LeafProps>][] = [
    ['command-only', CommandOnlyLeaf],
    ['edges-callback-only', EdgesCallbackOnlyLeaf],
    ['structure-reader', StructureReaderLeaf],
    ['placement-context', PlacementContextLeaf],
    ['edges-reader', EdgesReaderLeaf],
    ['canvas-context-whole', CanvasContextFieldsLeaf],
    ['ui-context-whole', UIContextFieldsLeaf],
    ['hover-node-id', HoverNodeIdLeaf],
    ['hover-edge-id', HoverEdgeIdLeaf],
    ['selected-nodes-map', SelectedNodesMapLeaf]
  ];
  singletons.forEach(([label, Component]) => {
    specs.push({ label, element: React.createElement(Component, { label }) });
  });

  const sampledNodes = perNodeLimit ? nodes.slice(0, perNodeLimit) : nodes;
  sampledNodes.forEach((node) => {
    const nodeId = node.nodeId;
    const nodeLeaves: [string, React.ComponentType<NodeLeafProps>][] = [
      ['node-card', NodeCardLeaf],
      ['is-tool-node', IsToolNodeLeaf],
      ['source-handle', SourceHandleLeaf],
      ['target-handle', TargetHandleLeaf],
      ['connection-target', ConnectionTargetLeaf]
    ];
    nodeLeaves.forEach(([family, Component]) => {
      const leafLabel = `${family}:${nodeId}`;
      specs.push({
        label: leafLabel,
        element: React.createElement(Component, { label: leafLabel, nodeId })
      });
    });
    if (runtime.getNode(nodeId)?.inputs.some((input) => input.key === editableFieldKey)) {
      const leafLabel = `field:${nodeId}`;
      specs.push({
        label: leafLabel,
        element: React.createElement(FieldLeaf, { label: leafLabel, nodeId })
      });
    }
  });

  edges.forEach((edge, index) => {
    const leafLabel = `edge:${index}`;
    specs.push({
      label: leafLabel,
      element: React.createElement(EdgeLeaf, {
        label: leafLabel,
        // 投影边 id 编码 runtime 边数组下标；新增边追加在末尾，既有下标不漂。
        edgeId: `wfedge-${index}`,
        source: edge.source,
        target: edge.target
      })
    });
  });

  return specs;
};
