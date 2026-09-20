import { describe, expect, it } from 'vitest';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import type {
  WorkflowRuntimePort,
  WorkflowSnapshot
} from '@fastgpt/global/core/workflow/editor/types';
import {
  deriveFoldIndexes,
  deriveStructureIndexes
} from '@/pageComponents/app/detail/WorkflowComponents/context/workflowInitContext';

type SnapshotNode = {
  nodeId: string;
  flowNodeType: FlowNodeTypeEnum;
  parentNodeId?: string;
};
type SnapshotEdge = { source: string; target: string; targetHandle?: string };

/** 派生只读 nodeId/parentNodeId/flowNodeType 与边的 handle，其余字段用不上。 */
const toSnapshot = (nodes: SnapshotNode[], edges: SnapshotEdge[] = []) =>
  ({ nodes, edges }) as unknown as WorkflowSnapshot;

/** 折叠派生只读 getNodeView。 */
const toRuntime = (views: Record<string, { isFolded?: boolean }>) =>
  ({ getNodeView: (nodeId: string) => views[nodeId] }) as unknown as WorkflowRuntimePort;

describe('deriveStructureIndexes', () => {
  it('derives ids, amount, parent map and type flags in one pass', () => {
    const indexes = deriveStructureIndexes(
      toSnapshot(
        [
          { nodeId: 'start', flowNodeType: FlowNodeTypeEnum.workflowStart },
          { nodeId: 'loop', flowNodeType: FlowNodeTypeEnum.loop },
          { nodeId: 'child1', flowNodeType: FlowNodeTypeEnum.emptyNode, parentNodeId: 'loop' },
          { nodeId: 'child2', flowNodeType: FlowNodeTypeEnum.emptyNode, parentNodeId: 'loop' },
          { nodeId: 'tool', flowNodeType: FlowNodeTypeEnum.toolCall },
          { nodeId: 'loopRun', flowNodeType: FlowNodeTypeEnum.loopRun }
        ],
        [{ source: 'start', target: 'tool', targetHandle: NodeOutputKeyEnum.selectedTools }]
      )
    );

    expect(indexes.nodeIds).toEqual(['start', 'loop', 'child1', 'child2', 'tool', 'loopRun']);
    expect(indexes.nodeAmount).toBe(6);
    expect(indexes.childrenNodeIdListMap).toEqual({ loop: ['child1', 'child2'] });
    expect(indexes.toolNodesMap).toEqual({ tool: true });
    expect(indexes.workflowStartNodeId).toBe('start');
    expect(indexes.hasToolNode).toBe(true);
    expect(indexes.hasLoopRunNode).toBe(true);
  });

  it('ignores selectedTools edges pointing at nodes outside the document', () => {
    const indexes = deriveStructureIndexes(
      toSnapshot(
        [{ nodeId: 'start', flowNodeType: FlowNodeTypeEnum.workflowStart }],
        [{ source: 'start', target: 'ghost', targetHandle: NodeOutputKeyEnum.selectedTools }]
      )
    );

    expect(indexes.toolNodesMap).toEqual({});
  });

  it('returns empty indexes before the runtime is hydrated', () => {
    expect(deriveStructureIndexes(undefined)).toEqual({
      nodeIds: [],
      nodeAmount: 0,
      childrenNodeIdListMap: {},
      toolNodesMap: {},
      workflowStartNodeId: undefined,
      hasToolNode: false,
      hasLoopRunNode: false
    });
  });
});

describe('deriveFoldIndexes', () => {
  const nodes: SnapshotNode[] = [
    { nodeId: 'a', flowNodeType: FlowNodeTypeEnum.emptyNode },
    { nodeId: 'b', flowNodeType: FlowNodeTypeEnum.emptyNode },
    { nodeId: 'comment', flowNodeType: FlowNodeTypeEnum.comment }
  ];

  it('reads fold state from node views', () => {
    const indexes = deriveFoldIndexes(
      toSnapshot(nodes),
      toRuntime({ a: { isFolded: true }, b: { isFolded: false } })
    );

    expect(indexes.foldedNodesMap).toEqual({ a: true });
    expect(indexes.allNodeFolded).toBe(false);
  });

  it('ignores comment nodes when checking allNodeFolded', () => {
    const indexes = deriveFoldIndexes(
      toSnapshot(nodes),
      toRuntime({ a: { isFolded: true }, b: { isFolded: true } })
    );

    expect(indexes.allNodeFolded).toBe(true);
  });

  it('treats an empty document or a missing runtime as all folded', () => {
    expect(deriveFoldIndexes(toSnapshot([]), toRuntime({}))).toEqual({
      foldedNodesMap: {},
      allNodeFolded: true
    });
    expect(deriveFoldIndexes(toSnapshot(nodes), null)).toEqual({
      foldedNodesMap: {},
      allNodeFolded: true
    });
  });
});
