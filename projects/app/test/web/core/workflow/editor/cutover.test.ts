// 兼容桥行为测试：写路径翻译（translate/changeProps）与投影组装。
import { describe, expect, it } from 'vitest';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { EDGE_TYPE, FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import { hydrateRuntime } from '@/web/core/workflow/editor/codec';
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

  it('drops repeated field writes from initialization effects', () => {
    const runtime = hydrateRuntime({ input: createStoreWorkflow(), t });
    const input = runtime.getNode('answer')!.inputs[0];

    const { commands, viewPatches } = translateChangeProps({
      props: [
        { nodeId: 'answer', type: 'updateInput', key: input.key, value: input },
        { nodeId: 'answer', type: 'replaceInput', key: input.key, value: input },
        { nodeId: 'answer', type: 'attr', key: 'readmeUrl', value: 'guide' }
      ],
      runtime
    });

    expect(commands).toEqual([]);
    expect(viewPatches).toEqual([{ nodeId: 'answer', values: { readmeUrl: 'guide' } }]);
    expect(runtime.dispatch(commands).change).toBeUndefined();
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

describe('cutover undo loop', () => {
  const project = (runtime: ReturnType<typeof hydrateRuntime>) =>
    projectRuntimeCanvas({
      runtime,
      overlays: {},
      issues: {} as WorkflowCheckNodeIssueMap,
      t,
      localNodes: [],
      localEdges: [],
      cache: createProjectionCache()
    });

  const readInput = (runtime: ReturnType<typeof hydrateRuntime>, nodeId: string, key: string) => {
    const node = project(runtime).nodes.find((item) => item.data.nodeId === nodeId)!;
    return node.data.inputs.find((input) => input.key === key)!;
  };

  /** 模拟输入模板写回：从投影读当前字段，带上新值走 changeProps -> Runtime。 */
  const writeInput = (
    runtime: ReturnType<typeof hydrateRuntime>,
    nodeId: string,
    key: string,
    value: unknown
  ) => {
    const item = readInput(runtime, nodeId, key);
    const { commands } = translateChangeProps({
      props: [{ nodeId, type: 'updateInput', key, value: { ...item, value } as never }],
      runtime
    });
    return commands.length > 0 ? runtime.dispatch(commands) : undefined;
  };

  it('walks every history step once when the canvas echoes the undone value', () => {
    const runtime = hydrateRuntime({ input: createStoreWorkflow(), t });
    const nodeId = 'answer';
    const key = (runtime.getNode(nodeId)!.inputs as { key: string }[])[0].key;
    const initial = runtime.getField({ nodeId, fieldKey: key })?.input?.value;
    const typed = ['1', '12', '123', '1234', '123', '12', '1', ''];

    typed.forEach((value) => writeInput(runtime, nodeId, key, value));
    const baseline = runtime.getHistory().undoCount;
    expect(baseline).toBe(typed.length);

    const undone: unknown[] = [];
    typed.forEach((_value, index) => {
      runtime.undo();
      // 撤销后画布重投影，受控输入会用恢复值再写一次（Lexical 重建时的 onChange）。
      const echoed = readInput(runtime, nodeId, key).value;
      writeInput(runtime, nodeId, key, echoed);
      undone.push(runtime.getField({ nodeId, fieldKey: key })?.input?.value);
      expect(runtime.getHistory().redoCount).toBe(index + 1);
    });

    // 撤销按记录逐条回退：先走完删除过程中的每个中间值，最后回到输入前的原始值。
    expect(undone).toEqual(['1', '12', '123', '1234', '123', '12', '1', initial]);
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
