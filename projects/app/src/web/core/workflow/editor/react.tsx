import React, {
  createContext,
  useEffect,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import type {
  DeepReadonly,
  WorkflowChange,
  WorkflowDispatchResult,
  WorkflowEdgeSnapshot,
  WorkflowFieldIdentity,
  WorkflowFieldQuery,
  WorkflowFieldSnapshot,
  WorkflowCommand,
  WorkflowNodeData,
  WorkflowNodeSnapshot,
  WorkflowNodeViewSnapshot,
  WorkflowRuntimePort,
  WorkflowSnapshot
} from '@fastgpt/global/core/workflow/editor';
import type { StoreEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import type { StoreNodeItemType } from '@fastgpt/global/core/workflow/type/node';

export type WorkflowNodeIdentity = {
  nodeId: string;
  parentNodeId?: string;
};

export type WorkflowStructureSnapshot = DeepReadonly<{
  nodes: WorkflowNodeIdentity[];
  edges: WorkflowEdgeSnapshot[];
}>;

export type WorkflowGeometryUpdate = {
  nodeId: string;
  position?: { x: number; y: number };
  isFolded?: boolean;
};

export type WorkflowNodeHandle = {
  data: WorkflowNodeSnapshot;
  view: WorkflowNodeViewSnapshot;
  setName: (name: string) => WorkflowDispatchResult;
  setFolded: (isFolded: boolean) => WorkflowDispatchResult;
  /**
   * 提交节点语义数据 patch（updateNode 命令）：记录级增删改由调用方读当前记录、
   * 拼完整数组后走这里，差异记录仍由 Runtime 按字段粒度发布。
   * patch 接受只读快照形状，位置与折叠不在此提交（只走 commitGeometry）。
   */
  updateNode: (
    patch: Partial<DeepReadonly<WorkflowNodeData>>,
    options?: WorkflowNodeUpdateOptions
  ) => WorkflowDispatchResult;
};

export type WorkflowFieldHandle = {
  data: WorkflowFieldSnapshot;
  reference: WorkflowFieldSnapshot['references'];
  setValue: (value: unknown) => WorkflowDispatchResult;
};

type WorkflowDisconnectEdge = Omit<Extract<WorkflowCommand, { type: 'disconnectEdge' }>, 'type'>;

export type WorkflowNodeUpdateOptions = {
  /**
   * 与 patch 同一事务断开的连线。
   * 删除或替换输出字段时旧 handle 上的连线必须一起消失；拆成两次 dispatch 会让撤销需要按两下。
   * index 需按降序给出：同一事务内逐条删除会改变后续下标。
   */
  disconnectEdges?: readonly WorkflowDisconnectEdge[];
};

export type WorkflowStructureHandle = WorkflowStructureSnapshot & {
  addNode: (node: StoreNodeItemType) => WorkflowDispatchResult;
  addNodes: (
    nodes: readonly StoreNodeItemType[],
    edge?: StoreEdgeItemType
  ) => WorkflowDispatchResult;
  connectEdge: (edge: StoreEdgeItemType) => WorkflowDispatchResult;
  disconnectEdge: (command: WorkflowDisconnectEdge) => WorkflowDispatchResult;
  removeNodes: (nodeIds: readonly string[]) => WorkflowDispatchResult;
  attachToContainer: (nodeId: string, containerId: string) => WorkflowDispatchResult;
};

export type WorkflowCanvasHandle = {
  commitGeometry: (updates: readonly WorkflowGeometryUpdate[]) => WorkflowDispatchResult;
};

type Listener = () => void;
type ListenerRegistry = Map<string, Set<Listener>>;

const getFieldIdentityKey = ({ nodeId, key, kind }: WorkflowFieldIdentity) =>
  `${nodeId}\0${kind}\0${key}`;

const getFieldQueryKey = ({ nodeId, fieldKey, kind }: WorkflowFieldQuery) =>
  `${nodeId}\0${kind ?? '*'}\0${fieldKey}`;

const freezeStructure = (workflow: WorkflowSnapshot): WorkflowStructureSnapshot =>
  Object.freeze({
    nodes: Object.freeze(
      workflow.nodes.map((node) =>
        Object.freeze({
          nodeId: node.nodeId,
          ...(node.parentNodeId !== undefined ? { parentNodeId: node.parentNodeId } : {})
        })
      )
    ),
    edges: workflow.edges
  }) as WorkflowStructureSnapshot;

const structureEqual = (previous: WorkflowStructureSnapshot, next: WorkflowStructureSnapshot) => {
  if (previous.nodes.length !== next.nodes.length || previous.edges.length !== next.edges.length) {
    return false;
  }
  return (
    previous.nodes.every(
      (node, index) =>
        node.nodeId === next.nodes[index].nodeId &&
        node.parentNodeId === next.nodes[index].parentNodeId
    ) &&
    previous.edges.every((edge, index) => {
      const nextEdge = next.edges[index];
      return (
        edge.source === nextEdge.source &&
        edge.sourceHandle === nextEdge.sourceHandle &&
        edge.target === nextEdge.target &&
        edge.targetHandle === nextEdge.targetHandle
      );
    })
  );
};

const notify = (listeners: Set<Listener>) => {
  listeners.forEach((listener) => listener());
};

const collectRegistryListeners = (registry: ListenerRegistry, nodeIds: readonly string[]) => {
  const notified = new Set<Listener>();
  nodeIds.forEach((nodeId) => {
    registry.get(nodeId)?.forEach((listener) => notified.add(listener));
  });
  return notified;
};

export type WorkflowEditorAdapter = {
  connect: () => void;
  getWorkflowSnapshot: () => WorkflowStructureHandle;
  subscribeWorkflow: (listener: Listener) => () => void;
  getNodeSnapshot: (nodeId: string) => WorkflowNodeHandle | undefined;
  subscribeNode: (nodeId: string, listener: Listener) => () => void;
  getFieldSnapshot: (query: WorkflowFieldQuery) => WorkflowFieldHandle | undefined;
  subscribeField: (query: WorkflowFieldQuery, listener: Listener) => () => void;
  getCanvasHandle: () => WorkflowCanvasHandle;
  dispose: () => void;
};

/**
 * 将 host-owned runtime 接入 React external store；adapter 释放自身订阅，生命周期不管理 runtime。
 */
export const createWorkflowEditorAdapter = (
  runtime: WorkflowRuntimePort,
  subscribeImmediately = true
): WorkflowEditorAdapter => {
  let disposed = false;
  let unsubscribeRuntime: (() => void) | undefined;
  let structure = freezeStructure(runtime.getWorkflow());
  const workflowActions = Object.freeze({
    addNode: (node: StoreNodeItemType) => runtime.dispatch({ type: 'addNode', node }),
    addNodes: (nodes: readonly StoreNodeItemType[], edge?: StoreEdgeItemType) =>
      runtime.dispatch([
        ...nodes.map((node) => ({ type: 'addNode' as const, node })),
        ...(edge ? [{ type: 'connectEdge' as const, edge }] : [])
      ]),
    connectEdge: (edge: StoreEdgeItemType) => runtime.dispatch({ type: 'connectEdge', edge }),
    disconnectEdge: (command: WorkflowDisconnectEdge) =>
      runtime.dispatch({ type: 'disconnectEdge', ...command }),
    removeNodes: (nodeIds: readonly string[]) =>
      runtime.dispatch({ type: 'removeNodes', nodeIds: [...nodeIds] }),
    attachToContainer: (nodeId: string, containerId: string) =>
      runtime.dispatch({ type: 'attachToContainer', nodeId, containerId })
  });
  const createWorkflowHandle = (snapshot: WorkflowStructureSnapshot): WorkflowStructureHandle =>
    Object.freeze({ ...snapshot, ...workflowActions });
  let workflowHandle = createWorkflowHandle(structure);
  const workflowListeners = new Set<Listener>();
  const nodeDataListeners: ListenerRegistry = new Map();
  const nodeViewListeners: ListenerRegistry = new Map();
  const fieldListeners: ListenerRegistry = new Map();
  const nodeHandles = new Map<string, WorkflowNodeHandle>();
  const fieldHandles = new Map<string, WorkflowFieldHandle>();
  const setNameActions = new Map<string, WorkflowNodeHandle['setName']>();
  const setFoldedActions = new Map<string, WorkflowNodeHandle['setFolded']>();
  const updateNodeActions = new Map<string, WorkflowNodeHandle['updateNode']>();

  const subscribeRegistry = (registry: ListenerRegistry, nodeId: string, listener: Listener) => {
    const listeners = registry.get(nodeId) ?? new Set<Listener>();
    listeners.add(listener);
    registry.set(nodeId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) registry.delete(nodeId);
    };
  };

  const setFolded = (nodeId: string, isFolded: boolean): WorkflowDispatchResult =>
    runtime.dispatch({ type: 'commitGeometry', nodeId, isFolded });

  const setName = (nodeId: string, name: string): WorkflowDispatchResult =>
    runtime.dispatch({ type: 'updateNode', nodeId, patch: { name } });

  const updateNode = (
    nodeId: string,
    patch: Partial<DeepReadonly<WorkflowNodeData>>,
    options?: WorkflowNodeUpdateOptions
  ): WorkflowDispatchResult => {
    const disconnects = options?.disconnectEdges;
    // Runtime 会 clone patch，只读快照可以原样透传。
    return runtime.dispatch([
      ...(disconnects?.map((command) => ({ type: 'disconnectEdge' as const, ...command })) ?? []),
      { type: 'updateNode', nodeId, patch: patch as Partial<WorkflowNodeData> }
    ]);
  };

  const getSetName = (nodeId: string) => {
    const previous = setNameActions.get(nodeId);
    if (previous) return previous;
    const action = (name: string) => setName(nodeId, name);
    setNameActions.set(nodeId, action);
    return action;
  };

  const getSetFolded = (nodeId: string) => {
    const previous = setFoldedActions.get(nodeId);
    if (previous) return previous;
    const action = (isFolded: boolean) => setFolded(nodeId, isFolded);
    setFoldedActions.set(nodeId, action);
    return action;
  };

  const getUpdateNode = (nodeId: string) => {
    const previous = updateNodeActions.get(nodeId);
    if (previous) return previous;
    const action = (
      patch: Partial<DeepReadonly<WorkflowNodeData>>,
      options?: WorkflowNodeUpdateOptions
    ) => updateNode(nodeId, patch, options);
    updateNodeActions.set(nodeId, action);
    return action;
  };

  /** 节点消失时一并丢弃句柄与缓存 action，避免删除后仍能被写。 */
  const dropNodeHandle = (nodeId: string) => {
    nodeHandles.delete(nodeId);
    setNameActions.delete(nodeId);
    setFoldedActions.delete(nodeId);
    updateNodeActions.delete(nodeId);
  };

  const getNodeSnapshot = (nodeId: string): WorkflowNodeHandle | undefined => {
    if (disposed) return undefined;
    const data = runtime.getNode(nodeId);
    const view = runtime.getNodeView(nodeId);
    if (!data || !view) {
      dropNodeHandle(nodeId);
      return undefined;
    }

    const previous = nodeHandles.get(nodeId);
    if (previous?.data === data && previous.view === view) return previous;

    const handle = {
      data,
      view,
      setName: getSetName(nodeId),
      setFolded: getSetFolded(nodeId),
      updateNode: getUpdateNode(nodeId)
    } satisfies WorkflowNodeHandle;
    nodeHandles.set(nodeId, handle);
    return handle;
  };

  const setFieldValue = (identity: WorkflowFieldIdentity, value: unknown): WorkflowDispatchResult =>
    runtime.dispatch({
      type: 'updateField',
      nodeId: identity.nodeId,
      fieldKey: identity.key,
      kind: identity.kind,
      value
    });

  const getSetFieldValue = (identity: WorkflowFieldIdentity) => {
    const identityKey = getFieldIdentityKey(identity);
    const previous = fieldHandles.get(identityKey)?.setValue;
    if (previous) return previous;
    return (value: unknown) => setFieldValue(identity, value);
  };

  const getFieldSnapshot = (query: WorkflowFieldQuery): WorkflowFieldHandle | undefined => {
    if (disposed) return undefined;
    const data = runtime.getField(query);
    if (!data) {
      const kinds = query.kind ? [query.kind] : (['input', 'output'] as const);
      kinds.forEach((kind) => {
        const key = getFieldIdentityKey({ nodeId: query.nodeId, key: query.fieldKey, kind });
        fieldHandles.delete(key);
      });
      return undefined;
    }

    const identity = { nodeId: data.nodeId, key: data.key, kind: data.kind };
    const identityKey = getFieldIdentityKey(identity);
    const previous = fieldHandles.get(identityKey);
    if (previous?.data === data) return previous;

    const handle = Object.freeze({
      data,
      reference: data.references,
      setValue: getSetFieldValue(identity)
    });
    fieldHandles.set(identityKey, handle);
    return handle;
  };

  const collectFieldListeners = (identities: readonly WorkflowFieldIdentity[]) => {
    const listeners = new Set<Listener>();
    identities.forEach((identity) => {
      [
        getFieldIdentityKey(identity),
        getFieldQueryKey({ nodeId: identity.nodeId, fieldKey: identity.key })
      ].forEach((key) => fieldListeners.get(key)?.forEach((listener) => listeners.add(listener)));
    });
    return listeners;
  };

  const onRuntimeChange = (change: WorkflowChange) => {
    if (disposed) return;

    if (change.kind === 'geometry') {
      notify(collectRegistryListeners(nodeViewListeners, change.changedRecords.nodeViewIds));
      return;
    }

    const nextStructure = freezeStructure(runtime.getWorkflow());
    const structureChanged = !structureEqual(structure, nextStructure);
    if (structureChanged) {
      structure = nextStructure;
      workflowHandle = createWorkflowHandle(structure);
    }

    const nodeDataIds = new Set([
      ...change.changedRecords.nodeIds,
      ...change.affectedRecords.nodeIds,
      ...change.changedRecords.fieldIds.map((field) => field.nodeId),
      ...change.affectedRecords.fieldIds.map((field) => field.nodeId)
    ]);
    const dataListeners = collectRegistryListeners(nodeDataListeners, [...nodeDataIds]);
    const viewListeners = collectRegistryListeners(
      nodeViewListeners,
      change.changedRecords.nodeViewIds
    );
    const fieldListenersToNotify =
      change.kind === 'replace'
        ? new Set([...fieldListeners.values()].flatMap((listeners) => [...listeners]))
        : collectFieldListeners([
            ...change.changedRecords.fieldIds,
            ...change.affectedRecords.fieldIds
          ]);

    if (change.kind === 'replace') {
      [...nodeHandles.keys()].forEach((nodeId) => {
        if (!runtime.getNode(nodeId)) dropNodeHandle(nodeId);
      });
      fieldHandles.clear();
      collectRegistryListeners(nodeDataListeners, [...nodeDataListeners.keys()]).forEach(
        (listener) => dataListeners.add(listener)
      );
      collectRegistryListeners(nodeViewListeners, [...nodeViewListeners.keys()]).forEach(
        (listener) => viewListeners.add(listener)
      );
    } else {
      change.changedRecords.nodeIds.forEach((nodeId) => {
        if (!runtime.getNode(nodeId)) dropNodeHandle(nodeId);
      });
    }
    dataListeners.forEach((listener) => viewListeners.delete(listener));
    notify(dataListeners);
    notify(viewListeners);
    notify(fieldListenersToNotify);
    if (structureChanged || change.kind === 'replace' || change.affectedRecords.structure) {
      notify(workflowListeners);
    }
  };

  const connect = () => {
    if (disposed || unsubscribeRuntime) return;
    unsubscribeRuntime = runtime.subscribe(onRuntimeChange);
  };
  if (subscribeImmediately) connect();
  const canvasHandle: WorkflowCanvasHandle = Object.freeze({
    commitGeometry: (updates) =>
      runtime.dispatch(
        updates.map(({ nodeId, position, isFolded }) => ({
          type: 'commitGeometry' as const,
          nodeId,
          ...(position ? { position: { x: position.x, y: position.y } } : {}),
          ...(isFolded !== undefined ? { isFolded } : {})
        }))
      )
  });

  return {
    connect,
    getWorkflowSnapshot: () => workflowHandle,
    subscribeWorkflow: (listener) => {
      if (disposed) return () => undefined;
      connect();
      workflowListeners.add(listener);
      return () => workflowListeners.delete(listener);
    },
    getNodeSnapshot,
    subscribeNode: (nodeId, listener) => {
      if (disposed) return () => undefined;
      connect();
      const dataUnsubscribe = subscribeRegistry(nodeDataListeners, nodeId, listener);
      const viewUnsubscribe = subscribeRegistry(nodeViewListeners, nodeId, listener);
      return () => {
        dataUnsubscribe();
        viewUnsubscribe();
      };
    },
    getFieldSnapshot,
    subscribeField: (query, listener) => {
      if (disposed) return () => undefined;
      connect();
      return subscribeRegistry(fieldListeners, getFieldQueryKey(query), listener);
    },
    getCanvasHandle: () => canvasHandle,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeRuntime?.();
      workflowListeners.clear();
      nodeDataListeners.clear();
      nodeViewListeners.clear();
      fieldListeners.clear();
      nodeHandles.clear();
      fieldHandles.clear();
      setNameActions.clear();
      setFoldedActions.clear();
      updateNodeActions.clear();
    }
  };
};

const WorkflowEditorContext = createContext<WorkflowEditorAdapter | undefined>(undefined);

type WorkflowEditorProviderProps = {
  /** host 在 hydrate 出 Runtime 之前为 null；此时不挂 adapter，hooks 与未挂载时一样抛错。 */
  runtime: WorkflowRuntimePort | null;
  children: ReactNode;
};

/** 为已经 hydrate 成功的 host runtime 提供 scoped Workflow Hooks。 */
export const WorkflowEditorProvider = ({ runtime, children }: WorkflowEditorProviderProps) => {
  const adapter = useMemo(
    () => (runtime ? createWorkflowEditorAdapter(runtime, false) : undefined),
    [runtime]
  );

  useEffect(() => {
    if (!adapter) return;
    adapter.connect();
    return () => adapter.dispose();
  }, [adapter]);

  return (
    <WorkflowEditorContext.Provider value={adapter}>{children}</WorkflowEditorContext.Provider>
  );
};

const useWorkflowEditorAdapter = () => {
  const adapter = useContext(WorkflowEditorContext);
  if (!adapter) throw new Error('Workflow hooks must be used inside WorkflowEditorProvider');
  return adapter;
};

/** 读取稳定的节点 identity/parent identity 与 edge 结构。 */
export const useWorkflow = (): WorkflowStructureHandle => {
  const adapter = useWorkflowEditorAdapter();
  return useSyncExternalStore(
    adapter.subscribeWorkflow,
    adapter.getWorkflowSnapshot,
    adapter.getWorkflowSnapshot
  );
};

/** 读取单节点的 Node Data、Node View State，并提供稳定的 fold action。 */
export const useNode = (nodeId: string): WorkflowNodeHandle | undefined => {
  const adapter = useWorkflowEditorAdapter();
  const subscribe = useMemo(
    () => (listener: Listener) => adapter.subscribeNode(nodeId, listener),
    [adapter, nodeId]
  );
  const getSnapshot = useMemo(() => () => adapter.getNodeSnapshot(nodeId), [adapter, nodeId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/** 读取单字段的 committed snapshot、引用状态，并提供稳定的字段提交 action。 */
export function useField(query: WorkflowFieldQuery): WorkflowFieldHandle | undefined;
export function useField(
  nodeId: string,
  fieldKey: string,
  kind?: WorkflowFieldQuery['kind']
): WorkflowFieldHandle | undefined;
export function useField(
  queryOrNodeId: WorkflowFieldQuery | string,
  fieldKey?: string,
  kind?: WorkflowFieldQuery['kind']
): WorkflowFieldHandle | undefined {
  const adapter = useWorkflowEditorAdapter();
  const queryNodeId = typeof queryOrNodeId === 'string' ? queryOrNodeId : queryOrNodeId.nodeId;
  const queryFieldKey = typeof queryOrNodeId === 'string' ? fieldKey : queryOrNodeId.fieldKey;
  const queryKind = typeof queryOrNodeId === 'string' ? kind : queryOrNodeId.kind;
  const query = useMemo(
    () => ({
      nodeId: queryNodeId,
      fieldKey: queryFieldKey!,
      ...(queryKind !== undefined ? { kind: queryKind } : {})
    }),
    [queryFieldKey, queryKind, queryNodeId]
  );
  const subscribe = useMemo(
    () => (listener: Listener) => adapter.subscribeField(query, listener),
    [adapter, query]
  );
  const getSnapshot = useMemo(() => () => adapter.getFieldSnapshot(query), [adapter, query]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 仅提供批量 geometry commit，不向 UI 暴露 runtime 或 generic dispatch。 */
export const useCanvas = (): WorkflowCanvasHandle => {
  const adapter = useWorkflowEditorAdapter();
  return adapter.getCanvasHandle();
};
