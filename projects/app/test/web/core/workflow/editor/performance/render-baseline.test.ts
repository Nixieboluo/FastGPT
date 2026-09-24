/**
 * 常驻的重渲染允许集合断言（06 总纲决策 7 / 8 / 9 的落地）。
 *
 * 14 条可驱动交互各一个用例（第 15 条「平移缩放」见 `guards.test.ts` 的静态断言），
 * 每条断言两组数据：
 * 1. 重渲染标签集合在预算内：变化集合按家族分组后，每个家族的实例数不超过契约上界，
 *    未列出的家族必须为 0，`mustInclude` 里的标签必须出现；
 * 2. 投影后身份变化的节点数与边数不超过契约上界。
 *
 * 「重渲染」在这里的定义是「该订阅者观察到的 snapshot 返回了新身份」，也就是它的子树会重渲染。
 * 组件函数被执行但观察值没变的情况不计入（原因见 `leaves.ts` 顶部注释），执行次数只进基线表。
 *
 * 允许集合断言只跑 7 节点的小 fixture：家族上界是按实例数写的，规模变了上界也要变。
 * 100 / 300 / 1000 节点的数字归一次性基线脚本（见 06a-1 与 06a-9 票据 Verification）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorFixture } from './fixtures';
import { installHarnessDom, mountEditorHarness, runInteraction } from './harness';
import type { InteractionSample } from './harness';
import { createInteractionContracts } from './interactions';
import type { InteractionContract } from './interactions';
import { leafFamily } from './leaves';

/** 把变化标签按家族分组，产出超出预算的违规项（带具体标签，方便定位是哪个实例）。 */
const collectViolations = (sample: InteractionSample, contract: InteractionContract) => {
  const allowed = contract.allowedRenders.families ?? {};
  const byFamily = new Map<string, string[]>();
  sample.changedLabels.forEach((label) => {
    const family = leafFamily(label);
    byFamily.set(family, [...(byFamily.get(family) ?? []), label]);
  });

  const violations: string[] = [];
  byFamily.forEach((labels, family) => {
    const budget = allowed[family] ?? 0;
    if (labels.length > budget) {
      violations.push(`${family}: ${labels.length} > ${budget} [${labels.join(', ')}]`);
    }
  });
  return violations;
};

const collectMissing = (sample: InteractionSample, contract: InteractionContract) =>
  (contract.allowedRenders.mustInclude ?? []).filter(
    (label) => !sample.changedLabels.includes(label)
  );

describe('workflow editor re-render budget', () => {
  beforeEach(() => {
    installHarnessDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  createInteractionContracts().forEach((contract) => {
    it(`${contract.name}: 重渲染集合与投影身份都在预算内`, async () => {
      const harness = await mountEditorHarness({ workflow: createEditorFixture() });
      try {
        const sample = await runInteraction(harness, contract);

        expect(collectViolations(sample, contract), sample.changedLabels.join(', ')).toEqual([]);
        expect(collectMissing(sample, contract), sample.changedLabels.join(', ')).toEqual([]);
        expect(sample.identityNodes).toBeLessThanOrEqual(contract.allowedIdentity.nodes);
        expect(sample.identityEdges).toBeLessThanOrEqual(contract.allowedIdentity.edges);
      } finally {
        await harness.unmount();
      }
    });
  });
});
