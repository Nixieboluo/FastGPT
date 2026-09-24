/**
 * 重渲染 harness 的合成 fixture：全部用代码生成，不入库大 JSON。
 *
 * 只有一份生成器。前 7 个节点是固定的「交互锚点」（A..E、L、LS），14 个标准交互全靠它们驱动，
 * 所以同一份交互契约在 7 / 100 / 300 / 1000 节点上都能跑：基线数字与允许集合断言共用一套 id。
 * 规模只由追加的合成节点决定，拓扑只决定合成节点之间怎么连边：
 * - chain：本轮最坏拓扑（引用链最长，结构变更的派生面最大）；
 * - star：压同源边（`edgeStepOffset` 与 handle 连通判定最贵）；
 * - plain：无边，只测节点侧订阅。
 */
import {
  NodeInputKeyEnum,
  NodeOutputKeyEnum,
  WorkflowIOValueTypeEnum
} from '@fastgpt/global/core/workflow/constants';
import {
  FlowNodeInputTypeEnum,
  FlowNodeOutputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import type { StoreNodeItemType } from '@fastgpt/global/core/workflow/type/node';

export const performanceSizes = [100, 300, 1000] as const;
export const performanceTopologies = ['chain', 'star', 'plain'] as const;
export type PerformanceTopology = (typeof performanceTopologies)[number];

/** 普通节点的可编辑字段 key；单字段提交交互写它。 */
export const editableFieldKey = 'perfText';

/**
 * 固定锚点 id。B 是带 `useAgentSandbox` 的 agent，环境事实刷新（refreshIssues）唯一能改
 * Issue View 的入口；C 经 selectedTools 挂成 B 的工具，使 `is-tool-node` 家族在初始文档里
 * 就有一个 true 实例；E 是根级可 attach 节点，L/LS 是 loopRun 容器与其 loopStart 子节点。
 */
export const anchorIds = {
  start: 'A',
  agent: 'B',
  tool: 'C',
  field: 'D',
  attachable: 'E',
  loop: 'L',
  loopStart: 'LS'
} as const;

/** 节点增删交互用的临时节点 id；增删前后文档回到同一形状，交互可重复跑。 */
export const addedNodeId = 'X';

export type FixtureNode = {
  nodeId: string;
  flowNodeType: FlowNodeTypeEnum;
  name: string;
  position: { x: number; y: number };
  inputs: Record<string, unknown>[];
  outputs: Record<string, unknown>[];
  parentNodeId?: string;
};

export type FixtureEdge = {
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
};

export type FixtureWorkflow = {
  nodes: FixtureNode[];
  edges: FixtureEdge[];
  chatConfig: Record<string, never>;
};

const textInput = (value: string) => ({
  key: editableFieldKey,
  label: 'Perf text',
  renderTypeList: [FlowNodeInputTypeEnum.input],
  selectedType: FlowNodeInputTypeEnum.input,
  valueType: WorkflowIOValueTypeEnum.string,
  value
});

const sourceOutput = () => ({
  id: 'source',
  key: 'source',
  label: 'Source',
  type: FlowNodeOutputTypeEnum.source,
  valueType: WorkflowIOValueTypeEnum.string
});

export const plainEdge = (source: string, target: string): FixtureEdge => ({
  source,
  target,
  sourceHandle: getHandleId(source, 'source', 'right'),
  targetHandle: getHandleId(target, 'target', 'left')
});

/** 带一个可编辑文本字段的 chatNode；`addNode` 要过 `StoreNodeItemTypeSchema`，io 字段必须齐全。 */
export const createTextNode = (nodeId: string, value = 'x0'): FixtureNode => ({
  nodeId,
  flowNodeType: FlowNodeTypeEnum.chatNode,
  name: nodeId,
  position: { x: 1200, y: 400 },
  inputs: [textInput(value)],
  outputs: [sourceOutput()]
});

const syntheticNodeId = (index: number) => `S${index}`;

const createAnchorNodes = (): FixtureNode[] => [
  {
    nodeId: anchorIds.start,
    flowNodeType: FlowNodeTypeEnum.workflowStart,
    name: 'A',
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [sourceOutput()]
  },
  {
    nodeId: anchorIds.agent,
    flowNodeType: FlowNodeTypeEnum.agent,
    name: 'B',
    position: { x: 200, y: 0 },
    inputs: [{ key: NodeInputKeyEnum.useAgentSandbox, value: true }],
    outputs: [sourceOutput()]
  },
  createTextNode(anchorIds.tool, 'c0'),
  createTextNode(anchorIds.field, 'd0'),
  createTextNode(anchorIds.attachable, 'e0'),
  {
    nodeId: anchorIds.loop,
    flowNodeType: FlowNodeTypeEnum.loopRun,
    name: 'L',
    position: { x: 1000, y: 0 },
    inputs: [],
    outputs: []
  },
  {
    nodeId: anchorIds.loopStart,
    flowNodeType: FlowNodeTypeEnum.loopRunStart,
    name: 'LS',
    position: { x: 1020, y: 20 },
    inputs: [],
    outputs: [sourceOutput()],
    parentNodeId: anchorIds.loop
  }
];

/**
 * 基础三条边固定在数组前三位：投影边 id 编码 runtime 边下标（`wfedge-{index}`），
 * 合成边只往后追加，所以 `edge:2`(C->D) 与 `wfedge-2` 在任何规模下都指同一条边。
 */
const createAnchorEdges = (): FixtureEdge[] => [
  plainEdge(anchorIds.start, anchorIds.agent),
  {
    source: anchorIds.agent,
    target: anchorIds.tool,
    sourceHandle: getHandleId(anchorIds.agent, 'source', 'right'),
    targetHandle: NodeOutputKeyEnum.selectedTools
  },
  plainEdge(anchorIds.tool, anchorIds.field)
];

/** 生成 fixture：`nodeCount` 为总节点数（含 7 个锚点）。缺省就是允许集合断言用的小 fixture。 */
export const createEditorFixture = ({
  nodeCount = 7,
  topology = 'plain'
}: {
  nodeCount?: number;
  topology?: PerformanceTopology;
} = {}): FixtureWorkflow => {
  const syntheticCount = Math.max(0, nodeCount - 7);
  const syntheticNodes: FixtureNode[] = Array.from({ length: syntheticCount }, (_, index) => ({
    ...createTextNode(syntheticNodeId(index), `v${index}`),
    position: { x: index * 40, y: 200 + (index % 5) * 160 }
  }));

  const syntheticEdges: FixtureEdge[] = [];
  if (topology === 'chain') {
    for (let index = 0; index < syntheticCount - 1; index++) {
      syntheticEdges.push(plainEdge(syntheticNodeId(index), syntheticNodeId(index + 1)));
    }
  } else if (topology === 'star') {
    for (let index = 1; index < syntheticCount; index++) {
      syntheticEdges.push(plainEdge(syntheticNodeId(0), syntheticNodeId(index)));
    }
  }

  return {
    nodes: [...createAnchorNodes(), ...syntheticNodes],
    edges: [...createAnchorEdges(), ...syntheticEdges],
    chatConfig: {}
  };
};

/** `addNode` 命令入参：与 fixture 节点同形状。 */
export const createAddedNode = (): StoreNodeItemType =>
  createTextNode(addedNodeId) as unknown as StoreNodeItemType;
