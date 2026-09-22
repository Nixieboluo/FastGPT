import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_ISSUE_I18N_KEYS,
  WorkflowIssueCode
} from '@fastgpt/global/core/workflow/editor/issueCode';
import type { WorkflowCheckIssue } from '@fastgpt/global/core/workflow/type/node';
import {
  getWorkflowIssueUIStatus,
  renderWorkflowIssueMessage
} from '@/web/core/workflow/issueView';

const i18nRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../packages/web/i18n'
);
const languages = ['zh-CN', 'en', 'zh-Hant', 'ko-KR'] as const;

const namespaceCache = new Map<string, Record<string, string>>();
const readNamespace = (language: string, namespace: string) => {
  const cacheKey = `${language}/${namespace}`;
  const cached = namespaceCache.get(cacheKey);
  if (cached) return cached;
  const parsed = JSON.parse(
    readFileSync(resolve(i18nRoot, language, `${namespace}.json`), 'utf8')
  ) as Record<string, string>;
  namespaceCache.set(cacheKey, parsed);
  return parsed;
};

/** 假 t：把 key 与插值参数原样拼出来，便于断言 inputName 是否被二次翻译。 */
const t = ((key: string, params?: Record<string, string>) =>
  params
    ? `${key}|${Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')}`
    : key) as never;

const createIssue = (issue: Omit<WorkflowCheckIssue, 'nodeId' | 'level'>): WorkflowCheckIssue => ({
  nodeId: 'node',
  level: 'error',
  ...issue
});

describe('renderWorkflowIssueMessage', () => {
  it('resolves the i18n key by code and re-translates inputName', () => {
    const message = renderWorkflowIssueMessage(
      createIssue({
        code: WorkflowIssueCode.requiredInputEmpty,
        params: { inputName: 'common:core.ai.Model' }
      }),
      t
    );

    // inputName 是 label 原始字符串（i18n key），渲染层对它再翻译一次，语言切换才会跟随。
    expect(message).toBe(
      'common:core.workflow.check.required_input_empty|inputName=common:core.ai.Model'
    );
  });

  it('keeps non-translatable params as raw data', () => {
    const message = renderWorkflowIssueMessage(
      createIssue({
        code: WorkflowIssueCode.modelUnavailable,
        params: { model: 'gpt-4o', nodeName: 'AI 对话', inputName: 'common:core.ai.Model' }
      }),
      t
    );

    expect(message).toContain('model=gpt-4o');
    // nodeName 是文档里已翻译的节点名，不再过 t。
    expect(message).toContain('nodeName=AI 对话');
  });

  it('renders codes without params as the bare key', () => {
    expect(renderWorkflowIssueMessage(createIssue({ code: WorkflowIssueCode.noUpstream }), t)).toBe(
      'common:core.workflow.check.no_upstream'
    );
  });
});

describe('getWorkflowIssueUIStatus', () => {
  it('marks external dependency failures as pending_handle', () => {
    expect(getWorkflowIssueUIStatus(WorkflowIssueCode.invalidReference)).toBe('pending_handle');
    expect(getWorkflowIssueUIStatus(WorkflowIssueCode.toolOffline)).toBe('pending_handle');
    expect(getWorkflowIssueUIStatus(WorkflowIssueCode.sandboxNotConfigured)).toBe('pending_handle');
  });

  it('marks everything else as pending_improve', () => {
    expect(getWorkflowIssueUIStatus(WorkflowIssueCode.requiredInputEmpty)).toBe('pending_improve');
    expect(getWorkflowIssueUIStatus(WorkflowIssueCode.ifElseIncomplete)).toBe('pending_improve');
  });
});

describe('WORKFLOW_ISSUE_I18N_KEYS', () => {
  it.each(languages)('has a translation for every issue code in %s', (language) => {
    const missing = Object.values(WorkflowIssueCode).filter((code) => {
      const [namespace, ...rest] = WORKFLOW_ISSUE_I18N_KEYS[code].split(':');
      return !(rest.join(':') in readNamespace(language, namespace));
    });

    expect(missing).toEqual([]);
  });
});
