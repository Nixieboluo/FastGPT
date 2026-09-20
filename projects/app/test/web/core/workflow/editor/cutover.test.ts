// [workflow-runtime-cutover] 兼容桥行为测试：写路径翻译（translate/changeProps）与投影组装。
import { describe, expect, it } from 'vitest';
import { NodeInputKeyEnum, NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { EDGE_TYPE, FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import { AiChatModule } from '@fastgpt/global/core/workflow/template/system/aiChat';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import { hydrateRuntime } from '@/web/core/workflow/editor/codec';
import {
  diffCanvasEdges,
  diffCanvasNodes,
  resolveRemovedEdgeIndexes,
  translateDragEndChanges,
  translateEdgeRemoveChanges,
  translateNodeRemoveChanges,
  type CanvasNode
} from '@/web/core/workflow/editor/cutover/translate';
import {
  buildDelEdgeCommands,
  buildResetNodeCommand,
  translateChangeProps,
  type FlowNodeChangeProps
} from '@/web/core/workflow/editor/cutover/changeProps';
import {
  createProjectionCache,
  projectRuntimeCanvas
} from '@/web/core/workflow/editor/cutover/projection';
import type { WorkflowCommand } from '@fastgpt/global/core/workflow/editor/types';
import type { WorkflowCheckNodeIssueMap } from '@fastgpt/global/core/workflow/type/node';

const t = ((key: string) => key) as never;

const canvasNode = (
  nodeId: string,
  data: Record<string, unknown> = {},
  position = { x: 0, y: 0 }
): CanvasNode =>
  ({
    id: nodeId,
    position,
    data: {
      nodeId,
      flowNodeType: FlowNodeTypeEnum.answerNode,
      name: nodeId,
      inputs: [],
      outputs: [],
      ...data
    }
  }) as unknown as CanvasNode;

const createStoreWorkflow = () => ({
  nodes: [
    {
      nodeId: 'start',
      flowNodeType: FlowNodeTypeEnum.workflowStart,
      name: 'Start',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [{ id: NodeOutputKeyEnum.userChatInput, key: NodeOutputKeyEnum.userChatInput }]
    },
    {
      nodeId: 'answer',
      flowNodeType: FlowNodeTypeEnum.answerNode,
      name: 'Answer',
      position: { x: 100, y: 0 },
      inputs: [],
      outputs: []
    },
    {
      nodeId: 'loop',
      flowNodeType: FlowNodeTypeEnum.loopRun,
      name: 'Loop',
      position: { x: 300, y: 0 },
      inputs: [],
      outputs: []
    },
    {
      nodeId: 'child',
      flowNodeType: FlowNodeTypeEnum.answerNode,
      name: 'Child',
      parentNodeId: 'loop',
      position: { x: 320, y: 20 },
      inputs: [],
      outputs: []
    }
  ],
  edges: [
    {
      source: 'start',
      target: 'answer',
      sourceHandle: getHandleId('start', 'source', NodeOutputKeyEnum.userChatInput),
      targetHandle: 'answer-target-left'
    }
  ],
  chatConfig: {}
});

const commandsOfType = (commands: WorkflowCommand[], type: string) =>
  commands.filter((command) => command.type === type);

describe('cutover translate: diffCanvasNodes', () => {
  it('splits semantic, geometry and view changes into commands and overlays', () => {
    const prev = [canvasNode('a', { name: 'A' })];
    const next = [
      canvasNode(
        'a',
        { name: 'B', isFolded: true, searchedText: 'kw', debugResult: { status: 'success' } },
        { x: 10, y: 0 }
      )
    ];

    const { commands, viewPatches } = diffCanvasNodes({ prev, next });

    expect(commandsOfType(commands, 'commitGeometry')).toEqual([
      { type: 'commitGeometry', nodeId: 'a', isFolded: true },
      { type: 'commitGeometry', nodeId: 'a', position: { x: 10, y: 0 } }
    ]);
    const updates = commandsOfType(commands, 'updateNode');
    expect(updates).toHaveLength(1);
    expect((updates[0] as Extract<WorkflowCommand, { type: 'updateNode' }>).patch).toMatchObject({
      name: 'B'
    });
    // 视图字段不进文档
    expect(
      (updates[0] as Extract<WorkflowCommand, { type: 'updateNode' }>).patch as Record<
        string,
        unknown
      >
    ).not.toHaveProperty('searchedText');
    expect(viewPatches).toEqual([
      {
        nodeId: 'a',
        values: { searchedText: 'kw', debugResult: { status: 'success' } }
      }
    ]);
  });

  it('translates removals into removeNodes and additions into stripped addNode', () => {
    const prev = [canvasNode('a'), canvasNode('b')];
    const next = [canvasNode('a'), canvasNode('c', { searchedText: 'kw' }, { x: 5, y: 5 })];

    const { commands } = diffCanvasNodes({ prev, next });

    expect(commandsOfType(commands, 'removeNodes')).toEqual([
      { type: 'removeNodes', nodeIds: ['b'] }
    ]);
    const add = commandsOfType(commands, 'addNode')[0] as Extract<
      WorkflowCommand,
      { type: 'addNode' }
    >;
    expect(add.node.nodeId).toBe('c');
    expect(add.node.position).toEqual({ x: 5, y: 5 });
    expect(add.node as Record<string, unknown>).not.toHaveProperty('searchedText');
  });

  it('routes parentNodeId changes through attachToContainer only', () => {
    const prev = [canvasNode('a'), canvasNode('loop', { flowNodeType: FlowNodeTypeEnum.loopRun })];
    const next = [
      canvasNode('a', { parentNodeId: 'loop' }),
      canvasNode('loop', { flowNodeType: FlowNodeTypeEnum.loopRun })
    ];

    const { commands } = diffCanvasNodes({ prev, next });

    expect(commandsOfType(commands, 'attachToContainer')).toEqual([
      { type: 'attachToContainer', nodeId: 'a', containerId: 'loop' }
    ]);
    commandsOfType(commands, 'updateNode').forEach((command) => {
      expect(
        (command as Extract<WorkflowCommand, { type: 'updateNode' }>).patch as Record<
          string,
          unknown
        >
      ).not.toHaveProperty('parentNodeId');
    });
  });
});

describe('cutover translate: edges', () => {
  const runtimeEdges = [
    { source: 'start', target: 'answer', sourceHandle: 'sh', targetHandle: 'th' },
    { source: 'start', target: 'tool', sourceHandle: 'sh2', targetHandle: 'th2' }
  ];
  const renderEdges = runtimeEdges.map((edge, index) => ({
    id: `wfedge-${index}`,
    ...edge
  }));

  it('connects new render edges and disconnects removed ones by fresh index', () => {
    const next = [
      renderEdges[1],
      { id: 'nanoid-new', source: 'answer', target: 'tool', sourceHandle: 'a', targetHandle: 'b' }
    ];

    const commands = diffCanvasEdges({ prev: renderEdges, next, runtimeEdges });

    expect(commands).toEqual([
      {
        type: 'connectEdge',
        edge: { source: 'answer', target: 'tool', sourceHandle: 'a', targetHandle: 'b' }
      },
      { type: 'disconnectEdge', index: 0 }
    ]);
  });

  it('skips removals that the runtime already cascaded (stale canvas index)', () => {
    // runtime 已级联删除 start->answer，仅剩一条边；画布 id 里的下标已失效。
    const freshRuntimeEdges = [runtimeEdges[1]];
    const indexes = resolveRemovedEdgeIndexes({
      removed: [renderEdges[0]],
      runtimeEdges: freshRuntimeEdges
    });
    expect(indexes).toEqual([]);

    const commands = translateEdgeRemoveChanges({
      ids: ['wfedge-0'],
      localEdges: renderEdges,
      runtimeEdges: freshRuntimeEdges
    });
    expect(commands).toEqual([]);
  });

  it('translates remove changes by value into descending indexes', () => {
    const commands = translateEdgeRemoveChanges({
      ids: ['wfedge-0', 'wfedge-1'],
      localEdges: renderEdges,
      runtimeEdges
    });
    expect(commands).toEqual([
      { type: 'disconnectEdge', index: 1 },
      { type: 'disconnectEdge', index: 0 }
    ]);
  });
});

describe('cutover translate: node changes', () => {
  it('only commits geometry on gesture-end frames', () => {
    const commands = translateDragEndChanges({
      changes: [
        { type: 'position', id: 'a', dragging: true, position: { x: 5, y: 5 } },
        { type: 'position', id: 'b', dragging: false, position: { x: 6, y: 6 } },
        { type: 'position', id: 'c', dragging: false },
        { type: 'select', id: 'd', selected: true }
      ] as never,
      getPosition: (nodeId) => (nodeId === 'c' ? { x: 7, y: 7 } : undefined)
    });

    expect(commands).toEqual([
      { type: 'commitGeometry', nodeId: 'b', position: { x: 6, y: 6 } },
      { type: 'commitGeometry', nodeId: 'c', position: { x: 7, y: 7 } }
    ]);
  });

  it('batches node remove changes into one removeNodes command', () => {
    expect(
      translateNodeRemoveChanges([
        { type: 'remove', id: 'a' },
        { type: 'remove', id: 'b' },
        { type: 'select', id: 'c', selected: false }
      ] as never)
    ).toEqual([{ type: 'removeNodes', nodeIds: ['a', 'b'] }]);
  });
});

describe('cutover changeProps', () => {
  it('merges record-level changes per node into one updateNode transaction', () => {
    const runtime = hydrateRuntime({ input: createStoreWorkflow(), t });
    const inputs = runtime.getNode('answer')!.inputs as { key: string }[];
    const targetKey = inputs[0]?.key ?? 'answerText';

    const props: FlowNodeChangeProps[] = [
      { nodeId: 'answer', type: 'attr', key: 'name', value: 'Renamed' },
      {
        nodeId: 'answer',
        type: 'updateInput',
        key: targetKey,
        value: { ...(inputs[0] as object), value: 'hello' } as never
      },
      { nodeId: 'answer', type: 'attr', key: 'searchedText', value: 'kw' },
      // 问题状态已迁出视图字段：旧调用点若仍写 isError，只会作为未知字段被 store schema 剥离。
      { nodeId: 'answer', type: 'attr', key: 'isError', value: true },
      { nodeId: 'answer', type: 'attr', key: 'isFolded', value: true }
    ];
    const { commands, viewPatches, duplicateKeyNodeIds } = translateChangeProps({ props, runtime });

    expect(duplicateKeyNodeIds).toEqual([]);
    expect(viewPatches).toEqual([{ nodeId: 'answer', values: { searchedText: 'kw' } }]);
    expect(commandsOfType(commands, 'commitGeometry')).toEqual([
      { type: 'commitGeometry', nodeId: 'answer', isFolded: true }
    ]);
    const updates = commandsOfType(commands, 'updateNode');
    expect(updates).toHaveLength(1);

    const res = runtime.dispatch(commands);
    expect(res.ok).toBe(true);
    const node = runtime.getNode('answer')!;
    expect(node.name).toBe('Renamed');
    expect(
      (node.inputs as { key: string; value?: unknown }[]).find((i) => i.key === targetKey)?.value
    ).toBe('hello');
    expect(runtime.getNodeView('answer')?.isFolded).toBe(true);
    const docNode = runtime.getNode('answer') as Record<string, unknown>;
    expect(docNode).not.toHaveProperty('isError');
    expect(docNode).not.toHaveProperty('searchedText');
    runtime.dispose();
  });

  it('reports duplicate keys instead of emitting the record change', () => {
    const runtime = hydrateRuntime({ input: createStoreWorkflow(), t });
    const inputs = runtime.getNode('answer')!.inputs as { key: string }[];
    expect(inputs.length).toBeGreaterThan(0);

    const { commands, duplicateKeyNodeIds } = translateChangeProps({
      props: [
        {
          nodeId: 'answer',
          type: 'addInput',
          value: { key: inputs[0].key } as never
        }
      ],
      runtime
    });

    expect(duplicateKeyNodeIds).toEqual(['answer']);
    // 重复 key 的记录变更被跳过；允许携带原值 updateNode，Runtime 按相等补丁判定为
    // 无变化事务，不产生历史条目。
    const res = runtime.dispatch(commands);
    expect(res.ok).toBe(true);
    expect(res.change).toBeUndefined();
    expect(runtime.getHistory().canUndo).toBe(false);
    runtime.dispose();
  });

  it('disconnects output edges when deleting an output', () => {
    const runtime = hydrateRuntime({ input: createStoreWorkflow(), t });

    const { commands } = translateChangeProps({
      props: [
        {
          nodeId: 'start',
          type: 'delOutput',
          key: NodeOutputKeyEnum.userChatInput
        }
      ],
      runtime
    });

    expect(commandsOfType(commands, 'disconnectEdge')).toHaveLength(1);
    const res = runtime.dispatch(commands);
    expect(res.ok).toBe(true);
    expect(runtime.getWorkflow().edges).toHaveLength(0);
    runtime.dispose();
  });

  it('builds delEdge commands by handle and reset commands preserving geometry', () => {
    const runtime = hydrateRuntime({ input: createStoreWorkflow(), t });

    const delCommands = buildDelEdgeCommands({
      runtime,
      nodeId: 'answer',
      targetHandle: 'answer-target-left'
    });
    expect(delCommands).toEqual([{ type: 'disconnectEdge', index: 0 }]);

    const resetCommand = buildResetNodeCommand({
      runtime,
      nodeId: 'answer',
      template: {
        nodeId: 'ignored',
        flowNodeType: FlowNodeTypeEnum.answerNode,
        name: 'Template',
        inputs: [],
        outputs: []
      } as never
    });
    expect(resetCommand?.type).toBe('replaceNode');
    const res = runtime.dispatch([resetCommand!]);
    expect(res.ok).toBe(true);
    expect(runtime.getNode('answer')?.name).toBe('Template');
    // 重置保留当前位置
    expect(runtime.getNodeView('answer')?.position).toEqual({ x: 100, y: 0 });
    runtime.dispose();
  });
});

describe('cutover projection', () => {
  it('assembles nodes from document, view state, overlays and interaction state', () => {
    const runtime = hydrateRuntime({ input: createStoreWorkflow(), t });
    const cache = createProjectionCache();

    const first = projectRuntimeCanvas({
      runtime,
      overlays: {},
      issues: {},
      t,
      localNodes: [],
      localEdges: [],
      cache
    });

    expect(first.nodes.map((node) => node.id)).toEqual(['start', 'answer', 'loop', 'child']);
    const child = first.nodes.find((node) => node.id === 'child')!;
    expect(child.zIndex).toBe(1001);
    expect(child.position).toEqual({ x: 320, y: 20 });
    expect(first.edges).toHaveLength(1);
    expect(first.edges[0]).toMatchObject({
      id: 'wfedge-0',
      type: EDGE_TYPE,
      source: 'start',
      target: 'answer'
    });

    // 未变化时复用同一批对象（缓存命中）
    const second = projectRuntimeCanvas({
      runtime,
      overlays: {},
      issues: {},
      t,
      localNodes: first.nodes,
      localEdges: first.edges,
      cache
    });
    expect(second.nodes).toEqual(first.nodes);
    second.nodes.forEach((node, index) => {
      expect(node).toBe(first.nodes[index]);
    });

    // overlay 合并进节点 data，不进文档
    const withOverlay = projectRuntimeCanvas({
      runtime,
      overlays: {
        answer: { searchedText: 'kw' }
      },
      issues: {},
      t,
      localNodes: second.nodes,
      localEdges: second.edges,
      cache
    });
    const searched = withOverlay.nodes.find((node) => node.id === 'answer')!;
    expect(searched.data.searchedText).toBe('kw');
    expect(runtime.getNode('answer') as Record<string, unknown>).not.toHaveProperty('searchedText');

    // 问题存储供问题文案、标红与选中；焦点只标红一个节点，问题未变的节点复用缓存对象
    const issues: WorkflowCheckNodeIssueMap = {
      answer: [
        {
          nodeId: 'answer',
          nodeType: FlowNodeTypeEnum.answerNode,
          level: 'error',
          code: 'required_input_empty',
          message: 'required_input_empty'
        }
      ]
    };
    const withIssues = projectRuntimeCanvas({
      runtime,
      overlays: { answer: { searchedText: 'kw' } },
      issues,
      errorNodeId: 'answer',
      t,
      localNodes: withOverlay.nodes,
      localEdges: withOverlay.edges,
      cache
    });
    const answer = withIssues.nodes.find((node) => node.id === 'answer')!;
    expect(answer.data.workflowCheckIssues).toEqual(issues.answer);
    expect(answer.data.isError).toBe(true);
    expect(answer.selected).toBe(true);
    const start = withIssues.nodes.find((node) => node.id === 'start')!;
    expect(start.data.isError).toBeUndefined();
    expect(start).toBe(withOverlay.nodes.find((node) => node.id === 'start'));
    // 问题状态只存在于投影结果，文档里没有 isError / workflowCheckIssues
    const docAnswer = runtime.getNode('answer') as Record<string, unknown>;
    expect(docAnswer).not.toHaveProperty('isError');
    expect(docAnswer).not.toHaveProperty('workflowCheckIssues');

    // 交互状态从本地保留；拖拽中的位置以本地为准。焦点清除后选中态回到本地数组的值。
    const withInteraction = projectRuntimeCanvas({
      runtime,
      overlays: {},
      issues,
      t,
      localNodes: withIssues.nodes.map((node) =>
        node.id === 'answer'
          ? { ...node, selected: true, width: 200, dragging: true, position: { x: 99, y: 99 } }
          : node
      ),
      localEdges: withIssues.edges,
      cache
    });
    const dragged = withInteraction.nodes.find((node) => node.id === 'answer')!;
    expect(dragged.selected).toBe(true);
    expect(dragged.width).toBe(200);
    expect(dragged.position).toEqual({ x: 99, y: 99 });
    expect(dragged.data.isError).toBeUndefined();
    expect(dragged.data.workflowCheckIssues).toEqual(issues.answer);

    // 折叠状态来自 Node View：commitGeometry 后投影需合并 isFolded
    const foldRes = runtime.dispatch([
      { type: 'commitGeometry', nodeId: 'answer', isFolded: true }
    ]);
    expect(foldRes.ok).toBe(true);
    const folded = projectRuntimeCanvas({
      runtime,
      overlays: {},
      issues: {},
      t,
      localNodes: withInteraction.nodes,
      localEdges: withInteraction.edges,
      cache
    });
    expect(folded.nodes.find((node) => node.id === 'answer')!.data.isFolded).toBe(true);
    expect(folded.nodes.find((node) => node.id === 'start')!.data.isFolded).toBeFalsy();
    // 问题清空后，问题文案随之从节点 data 消失
    expect(
      folded.nodes.find((node) => node.id === 'answer')!.data.workflowCheckIssues
    ).toBeUndefined();

    runtime.dispose();
  });
});

describe('cutover projection: 输出可用性写回收敛', () => {
  const reasoningModel = { modelId: 'reasoning-model', config: { reasoning: true } };

  const createAiChatWorkflow = () => ({
    nodes: [
      {
        ...AiChatModule,
        nodeId: 'chat',
        position: { x: 0, y: 0 },
        inputs: AiChatModule.inputs.map((input) =>
          input.key === NodeInputKeyEnum.aiModelId ? { ...input, value: 'reasoning-model' } : input
        )
      }
    ],
    edges: [],
    chatConfig: {}
  });

  /** 复刻 useNodeOutputValidity 的写回：按模型能力重算 invalid，产出新的画布数组。 */
  const applyOutputValidity = (nodes: CanvasNode[]) =>
    nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        outputs: node.data.outputs.map((output) =>
          output.invalidCondition
            ? {
                ...output,
                invalid: output.invalidCondition({
                  inputs: node.data.inputs,
                  llmModelMap: { 'reasoning-model': reasoningModel }
                } as never)
              }
            : output
        )
      }
    }));

  it('首次修正后不再产生新的历史条目', () => {
    const runtime = hydrateRuntime({ input: createAiChatWorkflow(), t });
    const cache = createProjectionCache();
    const project = (localNodes: CanvasNode[] = []) =>
      projectRuntimeCanvas({
        runtime,
        overlays: {},
        issues: {},
        t,
        localNodes,
        localEdges: [],
        cache
      });

    const first = project();
    const firstDiff = diffCanvasNodes({
      prev: first.nodes,
      next: applyOutputValidity(first.nodes)
    });
    // 模型支持思考时，模板默认的 invalid: true 需要被修正一次
    expect(commandsOfType(firstDiff.commands, 'updateNode')).toHaveLength(1);
    expect(runtime.dispatch(firstDiff.commands).ok).toBe(true);

    // 重投影后同一份写回必须已经收敛：否则每轮投影都会再写一条历史（打开工作流即无限循环）
    const second = project(first.nodes);
    const secondDiff = diffCanvasNodes({
      prev: second.nodes,
      next: applyOutputValidity(second.nodes)
    });
    expect(secondDiff.commands).toEqual([]);

    const outputs = runtime.getNode('chat')!.outputs as { key: string; invalid?: boolean }[];
    expect(outputs.find((output) => output.key === NodeOutputKeyEnum.reasoningText)?.invalid).toBe(
      false
    );

    runtime.dispose();
  });
});
