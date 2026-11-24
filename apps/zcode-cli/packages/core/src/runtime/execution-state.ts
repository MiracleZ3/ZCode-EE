import { resolveExecutionState, type ExecutionState } from "@zcode/shared";
import {
  resolveManagedPermissionMode,
  SESSION_ENTRY_EXECUTION_STATE,
  SessionEventType,
  type CollaborationMode,
  type TraceContext,
  type SessionId,
  type SessionEntryInfo,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "./permission-grant-recovery.js";
import { ManagedPolicyModeError } from "../permission/service.js";

/**
 * 企业受管策略（T2）下，一次被禁的模式或 Plan 的变更怎么处理。规格见
 * docs/design/v2/enterprise-managed-policy.md 的“入口处与界面公布”。
 *
 * - `reject`：用户显式切换，抛错，状态不变。
 * - `fallback`：随请求携带的状态声明，以及运行时内部的缺省值，按回退模式生效。
 */
export type ManagedExecutionStatePolicy = "reject" | "fallback";

/**
 * 把受管策略套在一次执行状态的变更上。只看这次请求改动的部分：
 * 同值重申不算进入被禁的状态；只有“把 Plan 打开”才受 Plan 是否被禁的约束，关掉 Plan 永远允许。
 * 策略不限制模式时原样返回，调用路径与没有企业版改动时相同。
 */
export function applyManagedPolicyToExecutionState(
  service: { allowedModes(): readonly CollaborationMode[] | undefined } | undefined,
  previous: ExecutionState,
  next: ExecutionState,
  policy: ManagedExecutionStatePolicy,
): ExecutionState {
  const allowedModes = service?.allowedModes();
  if (!allowedModes) return next;
  const modeForbidden = next.mode !== previous.mode && !allowedModes.includes(next.mode);
  const planForbidden =
    next.planEnabled && !previous.planEnabled && !allowedModes.includes("plan");
  if (!modeForbidden && !planForbidden) return next;
  if (policy === "reject") {
    throw new ManagedPolicyModeError(
      modeForbidden ? next.mode : "plan",
      allowedModes,
    );
  }
  const fallback = resolveManagedPermissionMode(next.mode, allowedModes);
  return {
    // 回退结果是 plan 时没有可写的权限模式：执行状态里 Plan 是独立开关。这时模式的值保持原样，
    // 工具调用由权限判定处按 Plan 处理（T3）。
    mode: modeForbidden ? (fallback === "plan" ? previous.mode : fallback) : next.mode,
    planEnabled: planForbidden ? false : next.planEnabled,
  };
}

export function readRuntimeExecutionState(runtime: AgentRuntimeInternal): ExecutionState {
  return resolveExecutionState(runtime.config);
}

export async function persistExecutionState(
  runtime: AgentRuntimeInternal,
  state = readRuntimeExecutionState(runtime),
): Promise<void> {
  if (!runtime.sessionPersisted || !runtime.sessionStore?.saveSessionEntry) return;
  await runtime.sessionStore.saveSessionEntry(buildExecutionStateEntry(runtime.sessionId, state));
}

export function buildExecutionStateEntry(
  sessionId: SessionId,
  state: ExecutionState,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${sessionId}:runtime-execution-state`,
    sessionID: sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: state,
  };
}

/** 权限与 Plan 是一个已消费状态；保存失败不发布成功快照，也不提前改内存。 */
export async function applyRuntimeExecutionState(
  runtime: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  cause: {
    source: "command" | "tool";
    toolCallId?: string;
    traceContext?: TraceContext;
    /** 缺省按显式切换处理（拒绝）；随请求携带的声明由调用方指定 `fallback`。 */
    managedPolicy?: ManagedExecutionStatePolicy;
  },
): Promise<ExecutionState> {
  if (runtime.permissionFullAccessPending)
    throw new Error("Permission update is busy; retry mode change");
  if (unpublishedPermissionGrants.has(runtime)) await recoverPendingPermissionGrant(runtime);
  const previous = readRuntimeExecutionState(runtime);
  // 企业受管策略（T2）：这是执行状态唯一的写入点，所有入口都汇到这里，所以在这里把关。
  // 必须排在落盘与发事件之前——被拒绝的请求不能留下半个状态。
  const next = applyManagedPolicyToExecutionState(
    runtime.permissionService,
    previous,
    resolveExecutionState(input, previous),
    cause.managedPolicy ?? "reject",
  );
  if (next.mode === previous.mode && next.planEnabled === previous.planEnabled) return next;
  if (next.planEnabled && !previous.planEnabled) {
    const goal = await runtime.readSessionTargetForContext?.(
      cause.traceContext ?? runtime.rootTraceContext,
    );
    if (goal?.status === "active")
      throw new Error("Plan and Goal cannot be active at the same time.");
  }
  await persistExecutionState(runtime, next);
  runtime.config.mode = next.mode;
  runtime.config.planEnabled = next.planEnabled;
  if (previous.planEnabled !== next.planEnabled)
    runtime.needsPlanModeExitReminder = !next.planEnabled;
  const trace = cause.traceContext ?? runtime.rootTraceContext;
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.SessionModeChanged,
      {
        ...next,
        previousMode: previous.mode,
        previousPlanEnabled: previous.planEnabled,
        source: cause.source,
        ...(cause.toolCallId ? { toolCallId: cause.toolCallId } : {}),
      },
      trace,
    ),
    trace,
  );
  return next;
}
