import { describe, expect, it } from 'vitest';
import {
  FlowNodeInputTypeEnum,
  FlowNodeOutputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import { NodeInputKeyEnum, WorkflowIOValueTypeEnum } from '@fastgpt/global/core/workflow/constants';
import { createWorkflowEditor } from '@fastgpt/global/core/workflow/editor/runtime/runtime';
import type {
  WorkflowChange,
  WorkflowCommand,
  WorkflowDispatchResult,
  WorkflowRuntimePort
} from '@fastgpt/global/core/workflow/editor/types';

const createRuntime = (): WorkflowRuntimePort => {
  const editor = createWorkflowEditor({
    nodes: [
      {
        nodeId: 'start',
        flowNodeType: FlowNodeTypeEnum.workflowStart,
        name: 'Start',
        inputs: [],
        outputs: [
          {
            id: 'userChatInput',
            key: 'userChatInput',
            type: FlowNodeOutputTypeEnum.source,
            valueType: WorkflowIOValueTypeEnum.string
          }
        ]
      },
      {
        nodeId: 'answer',
        flowNodeType: FlowNodeTypeEnum.answerNode,
        name: 'Answer',
        inputs: [
          {
            key: NodeInputKeyEnum.answerText,
            label: 'Answer',
            renderTypeList: [FlowNodeInputTypeEnum.reference],
            selectedType: FlowNodeInputTypeEnum.reference,
            valueType: WorkflowIOValueTypeEnum.string
          }
        ],
        outputs: []
      }
    ],
    edges: [],
    chatConfig: {}
  });
  editor.dispatch({
    type: 'connectEdge',
    edge: { source: 'start', target: 'answer', sourceHandle: 'source', targetHandle: 'target' }
  });
  return editor;
};

describe('workflow editor runtime modules', () => {
  it('commits a command batch atomically', () => {
    const editor = createRuntime();
    const beforeHistory = editor.getHistory();
    const result = editor.dispatch([
      { type: 'updateNode', nodeId: 'answer', patch: { name: 'Updated' } },
      { type: 'updateNode', nodeId: 'missing', patch: { name: 'Missing' } }
    ] satisfies readonly WorkflowCommand[]);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_found');
    expect(editor.getNode('answer')?.name).toBe('Answer');
    expect(editor.getNode('start')).toBeDefined();
    expect(editor.getHistory()).toEqual(beforeHistory);
  });

  it('treats an unchanged command as a no-op', () => {
    const editor = createRuntime();
    const beforeHistory = editor.getHistory();
    const result = editor.dispatch({
      type: 'updateChatConfig',
      chatConfig: editor.getWorkflowData().chatConfig as never
    });

    expect(result.ok).toBe(true);
    expect(result.change).toBeUndefined();
    expect(editor.getHistory()).toEqual(beforeHistory);
  });

  it('commits geometry once and restores it through history', () => {
    const editor = createRuntime();
    const changes: WorkflowChange[] = [];
    editor.subscribe((change) => changes.push(change));
    const result = editor.dispatch([
      { type: 'commitGeometry', nodeId: 'answer', position: { x: 20, y: 30 } },
      { type: 'commitGeometry', nodeId: 'start', position: { x: 40, y: 50 } }
    ] satisfies readonly WorkflowCommand[]);

    expect(result.ok).toBe(true);
    expect(result.change?.kind).toBe('geometry');
    expect(result.change?.changedRecords.nodeViewIds).toEqual(['answer', 'start']);
    expect(editor.getNodeView('answer')?.position).toEqual({ x: 20, y: 30 });
    expect(editor.undo().ok).toBe(true);
    expect(editor.getNodeView('answer')?.position).toBeUndefined();
    expect(editor.redo().ok).toBe(true);
    expect(editor.getNodeView('answer')?.position).toEqual({ x: 20, y: 30 });
    expect(changes).toHaveLength(3);
  });

  it('removes all runtime behavior after disposal', () => {
    const editor = createRuntime();
    const result: WorkflowDispatchResult = editor.dispatch({
      type: 'updateNode',
      nodeId: 'answer',
      patch: { name: 'Updated' }
    });
    expect(result.ok).toBe(true);
    editor.dispose();

    expect(() => editor.getWorkflow()).toThrow();
    expect(editor.dispatch({ type: 'removeNodes', nodeIds: ['answer'] }).error?.code).toBe(
      'disposed'
    );
  });

  it('derives reference options and statuses from the connected graph', () => {
    const editor = createRuntime();
    const query = { nodeId: 'answer', fieldKey: NodeInputKeyEnum.answerText };
    const options = editor.getField(query)?.referenceOptions ?? [];
    expect(options.map((item) => item.reference)).toContainEqual(['start', 'userChatInput']);
    expect(options.find((item) => item.reference[0] === 'start')).toEqual(
      expect.objectContaining({ sourceLabel: 'Start', outputLabel: 'userChatInput' })
    );

    editor.dispatch({ type: 'updateField', ...query, value: [['start', 'userChatInput']] });
    expect(editor.getField(query)?.references).toEqual([
      expect.objectContaining({ code: 'valid' })
    ]);
    expect(editor.getNode('answer')?.issues).toEqual([]);

    editor.dispatch({ type: 'updateField', ...query, value: [['start', 'missing']] });
    expect(editor.getField(query)?.references).toEqual([
      expect.objectContaining({ code: 'invalid_reference' })
    ]);
    expect(editor.getNode('answer')?.issues.map((issue) => issue.code)).toEqual([
      'invalid_reference'
    ]);
  });

  it('marks downstream consumers as affected without changing them', () => {
    const editor = createRuntime();
    editor.dispatch({
      type: 'updateField',
      nodeId: 'answer',
      fieldKey: NodeInputKeyEnum.answerText,
      value: [['start', 'userChatInput']]
    });

    const result = editor.dispatch({
      type: 'updateNode',
      nodeId: 'start',
      patch: { name: 'Renamed Start' }
    });

    expect(result.ok).toBe(true);
    expect(result.change?.changedRecords.nodeIds).toEqual(['start']);
    expect(result.change?.affectedRecords.nodeIds).toContain('answer');
    expect(result.change?.affectedRecords.fieldIds).toContainEqual({
      nodeId: 'answer',
      key: NodeInputKeyEnum.answerText,
      kind: 'input'
    });
    expect(
      editor.getField({ nodeId: 'answer', fieldKey: NodeInputKeyEnum.answerText })?.references[0]
    ).toEqual(expect.objectContaining({ sourceLabel: 'Renamed Start' }));
  });

  it('restores references and issues through undo and redo', () => {
    const editor = createRuntime();
    const query = { nodeId: 'answer', fieldKey: NodeInputKeyEnum.answerText };
    editor.dispatch({ type: 'updateField', ...query, value: [['start', 'userChatInput']] });
    expect(editor.getHistory()).toMatchObject({ canUndo: true, canRedo: false });

    expect(editor.undo().ok).toBe(true);
    expect(editor.getField(query)?.references).toEqual([]);
    expect(editor.getNode('answer')?.issues).toEqual([]);

    expect(editor.redo().ok).toBe(true);
    expect(editor.getField(query)?.references).toEqual([
      expect.objectContaining({ code: 'valid' })
    ]);
    expect(editor.getNode('answer')?.issues).toEqual([]);

    editor.dispatch({ type: 'updateNode', nodeId: 'answer', patch: { name: 'Branch' } });
    expect(editor.getHistory().canRedo).toBe(false);
  });

  it('keeps the public edge list stable across unrelated edits', () => {
    const editor = createRuntime();
    const before = editor.getWorkflow().edges;
    editor.dispatch({ type: 'updateNode', nodeId: 'answer', patch: { name: 'Renamed' } });
    expect(editor.getWorkflow().edges).toEqual(before);

    const result = editor.dispatch({
      type: 'disconnectEdge',
      edge: { source: 'start', target: 'answer', sourceHandle: 'source', targetHandle: 'target' }
    });
    expect(result.ok).toBe(true);
    expect(result.change?.changedRecords.edgeIds).toHaveLength(1);
    expect(editor.getWorkflow().edges).toHaveLength(before.length - 1);
  });

  it('replaces the whole document as an exclusive transaction', () => {
    const editor = createRuntime();
    const document = editor.getWorkflowData();
    const mixed = editor.dispatch([
      { type: 'replaceDocument', document },
      { type: 'updateNode', nodeId: 'answer', patch: { name: 'Ignored' } }
    ] satisfies readonly WorkflowCommand[]);
    expect(mixed.ok).toBe(false);
    expect(mixed.error?.code).toBe('invalid_command');

    const result = editor.dispatch({ type: 'replaceDocument', document });
    expect(result.ok).toBe(true);
    expect(result.change?.kind).toBe('replace');
    // dispatch 在提交前按 nodeChanges/edgeIds 重算 structureChanged，会覆盖 replace 分支置位的值。
    // 这是拆分前就存在的行为，契约调整放在后续独立变更里处理。
    expect(result.change?.affectedRecords.structure).toBe(false);
    expect(editor.getWorkflowData()).toEqual(document);
    expect(editor.undo().ok).toBe(true);
  });

  it('disconnects one edge by its runtime edge id without touching the other', () => {
    const editor = createRuntime();
    editor.dispatch({
      type: 'addNode',
      node: {
        nodeId: 'answer2',
        flowNodeType: FlowNodeTypeEnum.answerNode,
        name: 'Answer 2',
        inputs: [],
        outputs: []
      } as never
    });
    const connected = editor.dispatch({
      type: 'connectEdge',
      edge: { source: 'start', target: 'answer2', sourceHandle: 'source', targetHandle: 'target' }
    });
    expect(connected.ok).toBe(true);
    const [edgeId] = connected.change?.changedRecords.edgeIds ?? [];
    expect(edgeId).toEqual(expect.any(String));
    expect(editor.getWorkflow().edges).toHaveLength(2);

    editor.dispatch({ type: 'updateNode', nodeId: 'answer', patch: { name: 'Renamed' } });

    const disconnected = editor.dispatch({ type: 'disconnectEdge', edgeId });
    expect(disconnected.ok).toBe(true);
    expect(disconnected.change?.changedRecords.edgeIds).toEqual([edgeId]);
    expect(editor.getWorkflow().edges).toEqual([
      expect.objectContaining({ source: 'start', target: 'answer' })
    ]);
  });

  it('keeps semantic reads untouched for a pure geometry transaction', () => {
    const editor = createRuntime();
    const query = { nodeId: 'answer', fieldKey: NodeInputKeyEnum.answerText };
    editor.dispatch({ type: 'updateField', ...query, value: [['start', 'userChatInput']] });
    const workflowBefore = editor.getWorkflow();
    const nodeBefore = editor.getNode('answer');
    const fieldBefore = editor.getField(query);

    const result = editor.dispatch({
      type: 'commitGeometry',
      nodeId: 'answer',
      position: { x: 1, y: 2 }
    });

    expect(result.change?.kind).toBe('geometry');
    expect(result.change?.changedRecords.nodeIds).toEqual([]);
    expect(result.change?.changedRecords.fieldIds).toEqual([]);
    expect(result.change?.changedRecords.edgeIds).toEqual([]);
    expect(result.change?.affectedRecords.nodeIds).toEqual([]);
    expect(result.change?.affectedRecords.structure).toBe(false);
    // 纯 geometry 不推进语义版本，语义 scoped snapshot 必须保持同一对象身份。
    expect(editor.getWorkflow()).toBe(workflowBefore);
    expect(editor.getNode('answer')).toBe(nodeBefore);
    expect(editor.getField(query)).toBe(fieldBefore);
    expect(editor.getNodeView('answer')?.position).toEqual({ x: 1, y: 2 });
  });

  it('signals structure invalidation only when the graph really changes', () => {
    const editor = createRuntime();

    const renamed = editor.dispatch({
      type: 'updateNode',
      nodeId: 'start',
      patch: { name: 'Renamed Start' }
    });
    expect(renamed.change?.affectedRecords.structure).toBe(false);

    const added = editor.dispatch({
      type: 'addNode',
      node: {
        nodeId: 'answer2',
        flowNodeType: FlowNodeTypeEnum.answerNode,
        name: 'Answer 2',
        inputs: [],
        outputs: []
      } as never
    });
    expect(added.change?.affectedRecords.structure).toBe(true);
    expect(added.change?.affectedRecords.nodeIds).toContain('answer2');

    // 改变 outputs 属于结构变化，affected 需要带上引用闭包里的下游节点。
    const outputsChanged = editor.dispatch({
      type: 'updateNode',
      nodeId: 'start',
      patch: {
        outputs: [
          {
            id: 'userChatInput',
            key: 'userChatInput',
            type: FlowNodeOutputTypeEnum.source,
            valueType: WorkflowIOValueTypeEnum.string
          },
          {
            id: 'extra',
            key: 'extra',
            type: FlowNodeOutputTypeEnum.source,
            valueType: WorkflowIOValueTypeEnum.string
          }
        ]
      } as never
    });
    expect(outputsChanged.ok).toBe(true);
    expect(outputsChanged.change?.affectedRecords.structure).toBe(true);
    expect(outputsChanged.change?.affectedRecords.nodeIds).toContain('answer');
  });
});
