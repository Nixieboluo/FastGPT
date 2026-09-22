import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextSelector } from 'use-context-selector';
import { ReactFlowProvider } from 'reactflow';
import { AppContext } from '@/pageComponents/app/detail/context';
import { materializeWorkflow } from '@/web/core/workflow/editor/codec';
import { peekWorkflowModelDetails } from '@/web/core/workflow/modelData';
import { checkWorkflowNodeIssues } from '@/web/core/workflow/workflowCheck';
import { FlowNodeTypeEnum } from '@fastgpt/global/core/workflow/node/constant';
import {
  WorkflowHostContext,
  WorkflowHostProvider,
  type WorkflowHostValue
} from '@/web/core/workflow/editor/host';

vi.mock('next-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));
vi.mock('@/pageComponents/app/detail/context', async () => {
  const { createContext } = await import('use-context-selector');
  return {
    AppContext: createContext({
      appDetail: { chatConfig: {} },
      setAppDetail: () => undefined
    })
  };
});
vi.mock('@/web/core/workflow/localDraft/useWorkflowDraftLifecycle', () => ({
  useWorkflowDraftLifecycle: () => ({ authExpiredModal: undefined })
}));
vi.mock('@/web/core/workflow/modelData', () => ({
  getWorkflowModelDetails: vi.fn(async () => []),
  // 目录未就绪：Issue Provider 不产出环境问题，host 版本历史行为不受影响。
  peekWorkflowModelDetails: vi.fn(() => undefined)
}));
vi.mock('@/web/core/workflow/workflowCheck', () => ({
  checkWorkflowNodeIssues: vi.fn(() => ({})),
  checkWorkflowBeforeRunOrPublish: vi.fn(() => ({
    issueMap: {},
    hasError: false,
    firstErrorNodeId: undefined,
    errorNodeIds: [],
    chatConfigIssues: []
  }))
}));
vi.mock('@/web/core/workflow/editor/projection', () => ({
  createProjectionCache: () => ({}),
  projectRuntimeCanvas: () => ({ nodes: [], edges: [] })
}));
vi.mock('@/web/core/workflow/editor/react', () => ({
  WorkflowEditorProvider: ({ children }: { children: React.ReactNode }) => children
}));

const t = ((key: string) => key) as never;

describe('WorkflowHostProvider version history', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T10:00:00+08:00'));
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records every command immediately without adding entries when switching versions', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let host: WorkflowHostValue | undefined;
    const initial = materializeWorkflow({ input: { nodes: [], edges: [] }, chatConfig: {}, t });

    const Observer = () => {
      host = useContextSelector(WorkflowHostContext, (value) => value);
      return null;
    };

    await act(async () => {
      root.render(
        React.createElement(
          AppContext.Provider,
          {
            value: {
              appDetail: { chatConfig: initial.chatConfig },
              setAppDetail: vi.fn()
            } as never
          },
          // host 在 ReactFlowProvider 内（问题焦点要 fitView），测试同样需要这层 Provider。
          React.createElement(
            ReactFlowProvider,
            null,
            React.createElement(WorkflowHostProvider, null, React.createElement(Observer))
          )
        )
      );
    });

    act(() => host!.initRuntime(initial));
    expect(host!.versions).toHaveLength(1);

    act(() => {
      host!.runtime!.dispatch({
        type: 'updateChatConfig',
        chatConfig: { welcomeText: 'first edit' }
      });
    });
    expect(host!.versions).toHaveLength(2);

    vi.setSystemTime(new Date('2026-09-20T10:00:01+08:00'));
    act(() => {
      host!.runtime!.dispatch({
        type: 'updateChatConfig',
        chatConfig: { welcomeText: 'second edit' }
      });
    });
    expect(host!.versions).toHaveLength(3);

    const initialVersion = host!.versions.at(-1)!;
    const versionCount = host!.versions.length;
    const historyCount = (() => {
      const history = host!.runtime!.getHistory();
      return history.undoCount + history.redoCount;
    })();
    act(() => {
      host!.switchVersion(initialVersion, 'ignored-copy-title');
    });

    expect(host!.versions).toHaveLength(versionCount);
    const historyAfterSwitch = host!.runtime!.getHistory();
    expect(historyAfterSwitch.undoCount + historyAfterSwitch.redoCount).toBe(historyCount);
    const liveVersions = host!.versions.filter((item) => item.live);
    expect(liveVersions).toHaveLength(1);
    expect(liveVersions[0]?.content).toBe(initialVersion.content);

    const serialized = await host!.serializeWorkflowAndCheck(true);
    expect(serialized).toEqual(expect.objectContaining({ nodes: [], edges: [] }));

    act(() => root.unmount());
  });

  it('merges editor issue provider results into the runtime issue view', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let host: WorkflowHostValue | undefined;
    const initial = materializeWorkflow({
      input: {
        nodes: [
          {
            nodeId: 'answer',
            flowNodeType: FlowNodeTypeEnum.answerNode,
            name: 'Answer',
            position: { x: 0, y: 0 },
            inputs: [],
            outputs: []
          }
        ],
        edges: []
      },
      chatConfig: {},
      t
    });
    // 目录就绪 + 校验器产出一条环境问题：hydrate 阶段 provider 只被调用一次。
    vi.mocked(peekWorkflowModelDetails).mockReturnValueOnce([]);
    vi.mocked(checkWorkflowNodeIssues).mockReturnValueOnce({
      answer: [
        {
          nodeId: 'answer',
          nodeType: FlowNodeTypeEnum.answerNode,
          level: 'error',
          code: 'model_unavailable',
          message: 'model_unavailable'
        }
      ]
    });

    const Observer = () => {
      host = useContextSelector(WorkflowHostContext, (value) => value);
      return null;
    };

    await act(async () => {
      root.render(
        React.createElement(
          AppContext.Provider,
          { value: { appDetail: { chatConfig: {} }, setAppDetail: vi.fn() } as never },
          React.createElement(
            ReactFlowProvider,
            null,
            React.createElement(WorkflowHostProvider, null, React.createElement(Observer))
          )
        )
      );
    });

    act(() => {
      host?.initRuntime(initial);
    });

    // Workflow 与 Plugin host 共用这一份 provider 接线，issue 从 Runtime 统一读取面暴露。
    expect(host?.runtime?.getNode('answer')?.issues.map((issue) => issue.code)).toContain(
      'model_unavailable'
    );
    expect(host?.runtime?.getWorkflow().issues.map((issue) => issue.code)).toContain(
      'model_unavailable'
    );

    act(() => root.unmount());
  });
});
