/**
 * 标准交互的驱动函数与允许集合契约。
 *
 * 「平移缩放」在不挂 `<ReactFlow>` 的 harness 里无法驱动，改由 `guards.test.ts`
 * 做静态断言（画布节点组件零 `useViewport`）。其余 14 条在这里驱动，含 06a-9 补的
 * 「标红定位」——它是 host 视图计数器唯一的另一个写入方，06 票面反复点名却没有契约。
 *
 * 允许集合按**改造后的目标**写，是预算上界而不是等式：
 * - `families`：家族 -> 允许出现在变化集合里的实例数上界；未列出的家族必须为 0；
 * - `mustInclude`：必须出现的精确标签，锁定「是哪一个实例」变了；
 * - `allowedIdentity`：投影后身份变化的节点数与边数上界（各步求和）。
 * 按上界写而不是等式，是为了让后续改动把数字压得更低时不用回来改契约。
 */
import type { StoreEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import { addedNodeId, createAddedNode, editableFieldKey, plainEdge } from './fixtures';
import type { InteractionStep } from './harness';

/** 允许的重渲染集合：按家族 + 实例数上界写，不写死节点 id 全集（06 总纲决策 8）。 */
export type AllowedRenders = {
  /** 家族 -> 允许出现在变化集合里的实例数上界；未列出的家族必须为 0。 */
  families?: Record<string, number>;
  /** 必须出现在变化集合里的精确标签。 */
  mustInclude?: string[];
};

export type AllowedIdentity = { nodes: number; edges: number };

export type InteractionContract = {
  name: string;
  setup?: InteractionStep;
  steps: InteractionStep[];
  allowedRenders: AllowedRenders;
  allowedIdentity: AllowedIdentity;
};

const runtimeEdge = (source: string, target: string): StoreEdgeItemType =>
  plainEdge(source, target) as StoreEdgeItemType;

/** 拖拽帧只写画布本地数组，不进 Runtime（生产 handleNodeChange 对 dragging 帧不提交几何）。 */
const dragFrame = (nodeId: string, x: number, y: number): InteractionStep => {
  return ({ controls }) => {
    controls().onNodesChange([
      { type: 'position', id: nodeId, position: { x, y }, dragging: true }
    ]);
  };
};

const selectNode = (nodeId: string, selected: boolean): InteractionStep => {
  return ({ controls }) => {
    controls().onNodesChange([{ type: 'select', id: nodeId, selected }]);
  };
};

export const createInteractionContracts = (): InteractionContract[] => [
  {
    // 目标：只有被改的节点与它的字段订阅者刷新；语义派生随快照身份刷新一次。
    name: 'field-commit',
    steps: [
      ({ controls }) => {
        void controls().runtime.dispatch({
          type: 'updateField',
          nodeId: 'D',
          fieldKey: editableFieldKey,
          kind: 'input',
          value: 'v1'
        });
      }
    ],
    allowedRenders: {
      families: { 'node-card': 1, field: 1, 'edges-reader': 1 },
      mustInclude: ['node-card:D', 'field:D']
    },
    allowedIdentity: { nodes: 1, edges: 0 }
  },
  {
    // 目标：单边增删只重渲染两端节点与相关 handle，A 类/B 类消费点零重渲染。
    // edge 家族上界是全部 3 条：06a-4 任务 5 刻意保留 workflow.edges 作为 edgeStepOffset 的
    // 重算触发器，所以结构变更下所有边仍然刷新，这是已接受的目标状态。
    name: 'edge-change',
    steps: [
      ({ controls }) => {
        void controls().runtime.dispatch({ type: 'connectEdge', edge: runtimeEdge('A', 'E') });
      },
      ({ controls }) => {
        void controls().runtime.dispatch({ type: 'disconnectEdge', edge: runtimeEdge('A', 'E') });
      }
    ],
    allowedRenders: {
      families: {
        'structure-reader': 1,
        'placement-context': 1,
        'edges-reader': 1,
        'node-card': 2,
        'source-handle': 2,
        'target-handle': 2,
        edge: 3
      },
      mustInclude: ['node-card:E']
    },
    allowedIdentity: { nodes: 2, edges: 2 }
  },
  {
    // 目标：hover 一个节点只重渲染该节点的 source handle。
    name: 'hover-node',
    steps: [
      ({ controls }) => controls().setHoverNodeId('C'),
      ({ controls }) => controls().setHoverNodeId(undefined)
    ],
    allowedRenders: {
      families: { 'hover-node-id': 1, 'source-handle': 1 },
      mustInclude: ['source-handle:C']
    },
    allowedIdentity: { nodes: 0, edges: 0 }
  },
  {
    // 目标：hover 一条边只重渲染该边。
    name: 'hover-edge',
    steps: [
      ({ controls }) => controls().setHoverEdgeId('wfedge-2'),
      ({ controls }) => controls().setHoverEdgeId(undefined)
    ],
    allowedRenders: {
      families: { 'hover-edge-id': 1, edge: 1 },
      mustInclude: ['edge:2']
    },
    allowedIdentity: { nodes: 0, edges: 0 }
  },
  {
    // 目标：拖拽帧只换被拖节点的画布对象，任何订阅者都不刷新。
    name: 'drag-frame',
    steps: [dragFrame('C', 120, 40), dragFrame('C', 140, 60)],
    allowedRenders: { families: {} },
    allowedIdentity: { nodes: 2, edges: 0 }
  },
  {
    // 目标：几何提交只重渲染被移动节点；语义派生与 context 级订阅者零刷新。
    name: 'drag-drop',
    steps: [
      ({ controls }) => {
        controls().onNodesChange([
          { type: 'position', id: 'C', position: { x: 160, y: 80 }, dragging: false }
        ]);
        void controls().commitGeometry([{ nodeId: 'C', position: { x: 160, y: 80 } }]);
      }
    ],
    allowedRenders: { families: { 'node-card': 1 }, mustInclude: ['node-card:C'] },
    allowedIdentity: { nodes: 1, edges: 0 }
  },
  {
    // 目标：选中切换只让被选节点与其两端边刷新。
    name: 'select-toggle',
    steps: [selectNode('C', true), selectNode('C', false)],
    allowedRenders: {
      families: { 'selected-nodes-map': 1, 'source-handle': 1, edge: 2 },
      mustInclude: ['source-handle:C', 'edge:1', 'edge:2']
    },
    allowedIdentity: { nodes: 2, edges: 0 }
  },
  {
    // 目标：overlay 写入只重投影被 patch 的节点，任何订阅者都不刷新。
    name: 'overlay-write',
    steps: [
      ({ controls }) => {
        controls().patchViewData([
          {
            nodeId: 'C',
            values: { debugResult: { status: 'success', message: '', showResult: true } }
          }
        ]);
      }
    ],
    allowedRenders: { families: {} },
    allowedIdentity: { nodes: 1, edges: 0 }
  },
  {
    // 目标：undo/redo 是语义变更，被改节点与语义派生刷新；只写 action 的消费点不动。
    name: 'undo-redo',
    setup: ({ controls }) => {
      void controls().runtime.dispatch({
        type: 'updateField',
        nodeId: 'D',
        fieldKey: editableFieldKey,
        kind: 'input',
        value: 'setup'
      });
    },
    steps: [({ controls }) => controls().undo(), ({ controls }) => controls().redo()],
    allowedRenders: {
      families: { 'edges-reader': 1, 'node-card': 1, field: 1 },
      mustInclude: ['node-card:D', 'field:D']
    },
    allowedIdentity: { nodes: 2, edges: 0 }
  },
  {
    // 目标：节点增删只刷新结构读者与语义派生。新增的 X 没有叶子（叶子在挂载时生成），
    // 所以这里断言的是「其它节点一个都不该刷新」。
    name: 'node-add-remove',
    steps: [
      ({ controls }) => {
        void controls().runtime.dispatch({ type: 'addNode', node: createAddedNode() });
      },
      ({ controls }) => {
        void controls().runtime.dispatch({ type: 'removeNodes', nodeIds: [addedNodeId] });
      }
    ],
    allowedRenders: {
      families: { 'structure-reader': 1, 'placement-context': 1, 'edges-reader': 1, edge: 3 },
      mustInclude: ['structure-reader']
    },
    allowedIdentity: { nodes: 2, edges: 0 }
  },
  {
    // 目标：容器 attach 是结构变更；被 attach 的节点与结构读者刷新，其余节点不动。
    name: 'container-attach',
    steps: [
      ({ controls }) => {
        void controls().runtime.dispatch({
          type: 'attachToContainer',
          nodeId: 'E',
          containerId: 'L'
        });
      }
    ],
    allowedRenders: {
      families: {
        'structure-reader': 1,
        'placement-context': 1,
        'edges-reader': 1,
        'node-card': 2,
        edge: 3
      },
      mustInclude: ['node-card:E']
    },
    allowedIdentity: { nodes: 2, edges: 0 }
  },
  {
    // 目标：折叠是 Node View 变更；容器与其子节点刷新，语义派生零刷新。
    name: 'fold-toggle',
    steps: [
      ({ controls }) => {
        void controls().commitGeometry([{ nodeId: 'L', isFolded: true }]);
      },
      ({ controls }) => {
        void controls().commitGeometry([{ nodeId: 'L', isFolded: false }]);
      }
    ],
    allowedRenders: { families: { 'node-card': 2 }, mustInclude: ['node-card:L'] },
    allowedIdentity: { nodes: 2, edges: 0 }
  },
  {
    // 目标：环境事实刷新是「文档没变但 Issue View 全变」的唯一路径（06a-1 Notes 1）。
    // 只有带 Issue 的节点自己的订阅者刷新，语义派生与结构读者全部不动。
    name: 'refresh-issues',
    steps: [
      ({ controls }) => {
        controls().environment.sandboxConfigured = true;
        void controls().runtime.refreshIssues('all');
      }
    ],
    allowedRenders: { families: { 'node-card': 1 }, mustInclude: ['node-card:B'] },
    allowedIdentity: { nodes: 0, edges: 0 }
  },
  {
    // 目标：标红定位只写 host 的视图通道，被定位节点保持选中；语义派生零刷新。
    // 投影层对标红焦点节点强制 selected: true（06a-8 任务 4），所以 C 的 source handle
    // 与它两端的边会跟着刷新，这是投影的既有语义，不是订阅面漏收窄。
    name: 'focus-issue-node',
    steps: [
      ({ controls }) => controls().focusIssueNode('C'),
      ({ controls }) => controls().focusIssueNode(undefined)
    ],
    allowedRenders: {
      families: { 'selected-nodes-map': 1, 'source-handle': 1, edge: 2 },
      mustInclude: ['source-handle:C']
    },
    allowedIdentity: { nodes: 2, edges: 0 }
  }
];
