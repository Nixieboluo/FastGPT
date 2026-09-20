// [workflow-runtime-cutover] 临时兼容桥：旧 onChangeNode / onResetNode 变体 -> Runtime 命令。
// 命令面不扩展：记录级操作读当前记录、改完整份数组后走 updateNode（差异记录仍按字段粒度）。
import { getHandleId } from '@fastgpt/global/core/workflow/utils';
import { migrateToolInputConfig } from '@fastgpt/global/core/app/formEdit/utils';
import { StoreNodeItemTypeSchema } from '@fastgpt/global/core/workflow/type/node';
import type {
  FlowNodeItemType,
  FlowNodeTemplateType,
  StoreNodeItemType
} from '@fastgpt/global/core/workflow/type/node';
import type {
  FlowNodeInputItemType,
  FlowNodeOutputItemType
} from '@fastgpt/global/core/workflow/type/io';
import type { WorkflowCommand } from '@fastgpt/global/core/workflow/editor/types';
import type { WorkflowRuntimePort } from '@fastgpt/global/core/workflow/editor/types';
import { VIEW_DATA_KEYS, type ViewOverlayPatch, type ViewDataKey } from './translate';
import isEqual from 'lodash-es/isEqual';

/** 与旧 workflowActionsContext 的 FlowNodeChangeProps 保持同形。 */
export type FlowNodeChangeProps = { nodeId: string } & (
  | { type: 'attr'; key: string; value: any }
  | { type: 'updateInput'; key: string; value: FlowNodeInputItemType }
  | { type: 'replaceInput'; key: string; value: FlowNodeInputItemType }
  | { type: 'addInput'; value: FlowNodeInputItemType; index?: number }
  | { type: 'delInput'; key: string }
  | { type: 'updateOutput'; key: string; value: FlowNodeOutputItemType }
  | { type: 'replaceOutput'; key: string; value: FlowNodeOutputItemType }
  | { type: 'addOutput'; value: FlowNodeOutputItemType; index?: number }
  | { type: 'delOutput'; key: string }
);

export type ChangePropsTranslation = {
  commands: WorkflowCommand[];
  viewPatches: ViewOverlayPatch[];
  duplicateKeyNodeIds: string[];
  /**
   * attach 需要两段提交：先 attachToContainer（Runtime 清理非法边），
   * 再按最新快照断开旧路径剩余的连线（旧行为：attach 时删除该节点全部连线）。
   */
  attachRequests: { nodeId: string; containerId: string }[];
};

const isViewKey = (key: string): key is ViewDataKey =>
  (VIEW_DATA_KEYS as readonly string[]).includes(key);

type WorkingNode = {
  inputs: FlowNodeInputItemType[];
  outputs: FlowNodeOutputItemType[];
  originalInputs: FlowNodeInputItemType[];
  originalOutputs: FlowNodeOutputItemType[];
  patch: Record<string, unknown>;
};

const readWorkingNode = (runtime: WorkflowRuntimePort, nodeId: string): WorkingNode | undefined => {
  const snapshot = runtime.getNode(nodeId);
  if (!snapshot) return undefined;
  return {
    inputs: [...(snapshot.inputs as FlowNodeInputItemType[])],
    outputs: [...(snapshot.outputs as FlowNodeOutputItemType[])],
    originalInputs: [...(snapshot.inputs as FlowNodeInputItemType[])],
    originalOutputs: [...(snapshot.outputs as FlowNodeOutputItemType[])],
    patch: {}
  };
};

/**
 * 把一批旧式节点变更翻译成单个原子事务的命令列表。
 * 同一节点的多条记录级变更按顺序叠加后合成一条 updateNode；
 * 视图字段（debugResult 等）走 overlay，不进文档。
 */
export const translateChangeProps = ({
  props,
  runtime
}: {
  props: FlowNodeChangeProps[];
  runtime: WorkflowRuntimePort;
}): ChangePropsTranslation => {
  const commands: WorkflowCommand[] = [];
  const viewPatches: ViewOverlayPatch[] = [];
  const duplicateKeyNodeIds: string[] = [];
  const attachRequests: ChangePropsTranslation['attachRequests'] = [];
  const working = new Map<string, WorkingNode>();
  const viewValues = new Map<string, Partial<Record<ViewDataKey, unknown>>>();

  const getWorking = (nodeId: string) => {
    let node = working.get(nodeId);
    if (!node) {
      node = readWorkingNode(runtime, nodeId);
      if (node) working.set(nodeId, node);
    }
    return node;
  };
  const addViewValue = (nodeId: string, key: ViewDataKey, value: unknown) => {
    const values = viewValues.get(nodeId) ?? {};
    values[key] = value;
    viewValues.set(nodeId, values);
  };
  const disconnectOutputEdges = (nodeId: string, outputKey: string) => {
    const handle = getHandleId(nodeId, 'source', outputKey);
    const edges = runtime.getWorkflow().edges;
    const indexes: number[] = [];
    edges.forEach((edge, index) => {
      if (edge.source === nodeId && edge.sourceHandle === handle) indexes.push(index);
    });
    indexes
      .sort((a, b) => b - a)
      .forEach((index) => commands.push({ type: 'disconnectEdge', index }));
  };

  props.forEach((item) => {
    const { nodeId, type } = item;

    if (type === 'attr') {
      if (isViewKey(item.key)) {
        addViewValue(nodeId, item.key, item.value);
        return;
      }
      if (item.key === 'isFolded') {
        commands.push({ type: 'commitGeometry', nodeId, isFolded: !!item.value });
        return;
      }
      if (item.key === 'position' && item.value) {
        commands.push({ type: 'commitGeometry', nodeId, position: item.value });
        return;
      }
      if (item.key === 'parentNodeId') {
        if (item.value) attachRequests.push({ nodeId, containerId: String(item.value) });
        return;
      }
      const node = getWorking(nodeId);
      if (!node) return;
      const currentValue = Object.prototype.hasOwnProperty.call(node.patch, item.key)
        ? node.patch[item.key]
        : (runtime.getNode(nodeId) as Record<string, unknown> | undefined)?.[item.key];
      if (isEqual(currentValue, item.value)) return;
      node.patch[item.key] = item.value;
      return;
    }

    const node = getWorking(nodeId);
    if (!node) return;

    if (type === 'updateInput') {
      const index = node.inputs.findIndex((input) => input.key === item.key);
      if (index < 0 || isEqual(node.inputs[index], item.value)) return;
      node.inputs[index] = item.value;
    } else if (type === 'replaceInput') {
      const existingIndex = node.inputs.findIndex((input) => input.key === item.key);
      const hasInput = node.inputs.some(
        (input) => input.key === item.value.key && input.key !== item.key
      );
      if (hasInput) {
        duplicateKeyNodeIds.push(nodeId);
        return;
      }
      if (existingIndex >= 0 && isEqual(node.inputs[existingIndex], item.value)) return;
      node.inputs =
        existingIndex === -1
          ? [...node.inputs, item.value]
          : node.inputs.map((input) => (input.key === item.key ? item.value : input));
    } else if (type === 'addInput') {
      if (node.inputs.some((input) => input.key === item.value.key)) {
        duplicateKeyNodeIds.push(nodeId);
        return;
      }
      node.inputs = [...node.inputs, item.value];
    } else if (type === 'delInput') {
      if (!node.inputs.some((input) => input.key === item.key)) return;
      node.inputs = node.inputs.filter((input) => input.key !== item.key);
    } else if (type === 'updateOutput') {
      const index = node.outputs.findIndex((output) => output.key === item.key);
      if (index < 0 || isEqual(node.outputs[index], item.value)) return;
      node.outputs[index] = item.value;
    } else if (type === 'replaceOutput') {
      const index = node.outputs.findIndex((output) => output.key === item.key);
      if (index < 0 || isEqual(node.outputs[index], item.value)) return;
      disconnectOutputEdges(nodeId, item.key);
      node.outputs[index] = item.value;
    } else if (type === 'addOutput') {
      if (node.outputs.some((output) => output.key === item.value.key)) {
        duplicateKeyNodeIds.push(nodeId);
        return;
      }
      if (item.index !== undefined) {
        const outputs = [...node.outputs];
        outputs.splice(item.index, 0, item.value);
        node.outputs = outputs;
      } else {
        node.outputs = [...node.outputs, item.value];
      }
    } else if (type === 'delOutput') {
      if (!node.outputs.some((output) => output.key === item.key)) return;
      disconnectOutputEdges(nodeId, item.key);
      node.outputs = node.outputs.filter((output) => output.key !== item.key);
    }
  });

  working.forEach((node, nodeId) => {
    const patch: Record<string, unknown> = { ...node.patch };
    if (!isEqual(node.inputs, node.originalInputs)) patch.inputs = node.inputs;
    if (!isEqual(node.outputs, node.originalOutputs)) patch.outputs = node.outputs;
    if (Object.keys(patch).length === 0) return;
    commands.push({
      type: 'updateNode',
      nodeId,
      patch: patch as Partial<StoreNodeItemType>
    });
  });

  viewValues.forEach((values, nodeId) => viewPatches.push({ nodeId, values }));
  attachRequests.forEach(({ nodeId, containerId }) =>
    commands.push({ type: 'attachToContainer', nodeId, containerId })
  );

  return { commands, viewPatches, duplicateKeyNodeIds, attachRequests };
};

/**
 * attach 成功后断开该节点剩余的旧连线（旧行为：落入容器时删除全部连线）。
 * 必须在 attach 提交后按最新快照计算下标。
 */
export const collectPostAttachDisconnects = ({
  runtime,
  nodeId
}: {
  runtime: WorkflowRuntimePort;
  nodeId: string;
}): WorkflowCommand[] => {
  const edges = runtime.getWorkflow().edges;
  const indexes: number[] = [];
  edges.forEach((edge, index) => {
    if (edge.source === nodeId || edge.target === nodeId) indexes.push(index);
  });
  return indexes.sort((a, b) => b - a).map((index) => ({ type: 'disconnectEdge' as const, index }));
};

/** 旧 onResetNode：模板整体替换节点数据，保留当前位置、折叠与已配置的工具输入。 */
export const buildResetNodeCommand = ({
  runtime,
  nodeId,
  template
}: {
  runtime: WorkflowRuntimePort;
  nodeId: string;
  template: FlowNodeTemplateType;
}): WorkflowCommand | undefined => {
  const snapshot = runtime.getNode(nodeId);
  const view = runtime.getNodeView(nodeId);
  if (!snapshot) return undefined;

  const sourceInputMap = new Map(
    (snapshot.inputs as FlowNodeInputItemType[]).map((input) => [input.key, input])
  );
  const merged = {
    ...(snapshot as unknown as FlowNodeItemType),
    ...template,
    nodeId,
    inputs: template.inputs.map((input) =>
      migrateToolInputConfig({ input, sourceInput: sourceInputMap.get(input.key) })
    )
  };
  const storeNode = StoreNodeItemTypeSchema.parse({
    ...Object.fromEntries(
      Object.entries(merged).filter(([key]) => !(VIEW_DATA_KEYS as readonly string[]).includes(key))
    ),
    position: view?.position,
    isFolded: view?.isFolded
  });

  return { type: 'replaceNode', nodeId, node: storeNode };
};

/** 边删除回调（onDelEdge）：按 source/target handle 匹配并断开全部命中的边。 */
export const buildDelEdgeCommands = ({
  runtime,
  nodeId,
  sourceHandle,
  targetHandle
}: {
  runtime: WorkflowRuntimePort;
  nodeId: string;
  sourceHandle?: string;
  targetHandle?: string;
}): WorkflowCommand[] => {
  if (!sourceHandle && !targetHandle) return [];
  const edges = runtime.getWorkflow().edges;
  const indexes: number[] = [];
  edges.forEach((edge, index) => {
    if (sourceHandle && edge.source === nodeId && edge.sourceHandle === sourceHandle) {
      indexes.push(index);
      return;
    }
    if (targetHandle && edge.target === nodeId && edge.targetHandle === targetHandle) {
      indexes.push(index);
    }
  });
  return indexes.sort((a, b) => b - a).map((index) => ({ type: 'disconnectEdge' as const, index }));
};
