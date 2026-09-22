import { describe, expect, it } from 'vitest';
import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import type { WorkflowSnapshot } from '@fastgpt/global/core/workflow/editor/types';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import { hydrateRuntime } from '@/web/core/workflow/editor/codec';
import { createWorkflowIssueProvider } from '@/web/core/workflow/editor/issueProvider';

const t = ((key: string) => key) as never;

/**
 * 走真实入站边界（migration + Template Materialization）后取 Runtime 只读 snapshot：
 * provider 拿到的就是编辑期的冻结节点数据，校验器不能写坏它。
 */
const createSnapshot = (): WorkflowSnapshot =>
  hydrateRuntime({
    input: {
      nodes: [
        {
          nodeId: 'start',
          flowNodeType: FlowNodeTypeEnum.workflowStart,
          name: 'Start',
          position: { x: 0, y: 0 },
          inputs: [],
          outputs: []
        },
        {
          nodeId: 'http',
          flowNodeType: FlowNodeTypeEnum.httpRequest468,
          name: 'HTTP',
          position: { x: 0, y: 100 },
          inputs: [],
          outputs: []
        }
      ],
      edges: []
    },
    chatConfig: {},
    t
  }).getWorkflow();

describe('createWorkflowIssueProvider', () => {
  it('checks the readonly snapshot and keeps the requested node scope', () => {
    const provider = createWorkflowIssueProvider({ getModels: () => [], getT: () => t });

    const all = provider({ workflow: createSnapshot(), nodeIds: 'all' });
    expect(all.map((issue) => issue.code)).toContain('http_url_empty');
    expect(all.find((issue) => issue.code === 'http_url_empty')?.inputKey).toBe(
      NodeInputKeyEnum.httpReqUrl
    );

    // 定向刷新只输出 scope 内节点的问题，http 的结果不会串到别的节点上。
    const scoped = provider({ workflow: createSnapshot(), nodeIds: ['start'] });
    expect(scoped.filter((issue) => issue.nodeId === 'http')).toEqual([]);
  });

  it('produces nothing while the model catalog is not ready', () => {
    const provider = createWorkflowIssueProvider({ getModels: () => undefined, getT: () => t });

    // 目录未就绪时不能把“查不到模型”当成模型不可用，否则会误报整份文档。
    expect(provider({ workflow: createSnapshot(), nodeIds: 'all' })).toEqual([]);
  });
});
