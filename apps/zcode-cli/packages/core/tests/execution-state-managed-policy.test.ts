import { describe, expect, it, vi } from "vitest";
import type { CollaborationMode } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { applyRuntimeExecutionState } from "../src/runtime/execution-state.js";
import { updateConfig } from "../src/runtime/methods/config.js";
import { grantPermissionMode } from "../src/runtime/permission-full-access.js";
import { createRuntimeSessionModePort } from "../src/runtime/session-mode-port.js";
import { ManagedPolicyModeError, PermissionService } from "../src/permission/service.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T2）的“入口处与界面公布”。

type Policy = readonly CollaborationMode[] | undefined;

function fixture(input: { mode?: CollaborationMode; planEnabled?: boolean; allowedModes?: Policy } = {}) {
  const runtime = {
    sessionId: "session",
    // 不接会话库：这里只看状态与事件，落盘由别的测试覆盖。
    sessionPersisted: false,
    config: { mode: (input.mode ?? "build") as CollaborationMode, planEnabled: input.planEnabled ?? false },
    rootTraceContext: {},
    permissionService: new PermissionService(
      input.allowedModes ? { managedAllowedModes: [...input.allowedModes] } : {},
    ),
    permissionFullAccessPending: false,
    pendingInputReservations: new Map(),
    appendEvent: vi.fn(async () => {}),
    createEvent: vi.fn((type: string, payload: unknown) => ({ id: "event", type, payload })),
  };
  return { runtime: runtime as unknown as AgentRuntimeInternal, appendEvent: runtime.appendEvent };
}

const rejectCommand = { source: "command" } as const;
const fallbackCommand = { source: "command", managedPolicy: "fallback" } as const;

describe("execution state write point with a managed policy (T2)", () => {
  it("changes the mode as before when nothing is restricted", async () => {
    const { runtime, appendEvent } = fixture({ allowedModes: undefined });
    await applyRuntimeExecutionState(runtime, { mode: "yolo" }, rejectCommand);
    expect(runtime.config).toEqual({ mode: "yolo", planEnabled: false });
    expect(appendEvent).toHaveBeenCalledOnce();
  });

  it("rejects an explicit switch to a disabled mode and leaves the session untouched", async () => {
    const { runtime, appendEvent } = fixture({ allowedModes: ["build", "plan"] });
    await expect(
      applyRuntimeExecutionState(runtime, { mode: "yolo" }, rejectCommand),
    ).rejects.toBeInstanceOf(ManagedPolicyModeError);
    await expect(
      applyRuntimeExecutionState(runtime, { mode: "yolo" }, rejectCommand),
    ).rejects.toThrow(/'yolo' is disabled by the organization's managed policy/);
    await expect(
      applyRuntimeExecutionState(runtime, { mode: "yolo" }, rejectCommand),
    ).rejects.toThrow(/Allowed modes: build, plan/);
    expect(runtime.config).toEqual({ mode: "build", planEnabled: false });
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("still allows a switch to an allowed mode", async () => {
    const { runtime, appendEvent } = fixture({ allowedModes: ["build", "guarded"] });
    await applyRuntimeExecutionState(runtime, { mode: "guarded" }, rejectCommand);
    expect(runtime.config.mode).toBe("guarded");
    expect(appendEvent).toHaveBeenCalledOnce();
  });

  it("does not complain when the same disabled state is merely re-asserted", async () => {
    const { runtime, appendEvent } = fixture({ mode: "yolo", allowedModes: ["build"] });
    await applyRuntimeExecutionState(runtime, { mode: "yolo" }, rejectCommand);
    expect(runtime.config.mode).toBe("yolo");
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("rejects EnterPlanMode when the policy disables plan", async () => {
    const { runtime } = fixture({ allowedModes: ["build", "guarded"] });
    await expect(createRuntimeSessionModePort(runtime).enterPlanMode({})).rejects.toBeInstanceOf(
      ManagedPolicyModeError,
    );
    await expect(createRuntimeSessionModePort(runtime).enterPlanMode({})).rejects.toThrow(
      /Plan mode is disabled/,
    );
    expect(runtime.config.planEnabled).toBe(false);
  });

  it("turns a declared state onto the fallback mode instead of failing the request", async () => {
    const { runtime } = fixture({ allowedModes: ["build", "plan"] });
    await applyRuntimeExecutionState(runtime, { mode: "yolo", planEnabled: true }, fallbackCommand);
    expect(runtime.config).toEqual({ mode: "build", planEnabled: true });
  });

  it("falls back to the strictest allowed mode when build is not allowed", async () => {
    const { runtime } = fixture({ mode: "guarded", allowedModes: ["guarded"] });
    await applyRuntimeExecutionState(runtime, { mode: "build" }, fallbackCommand);
    expect(runtime.config.mode).toBe("guarded");
    await applyRuntimeExecutionState(runtime, { mode: "yolo" }, fallbackCommand);
    expect(runtime.config.mode).toBe("guarded");
  });

  it("keeps the mode value when only plan is allowed, since plan is not a writable mode", async () => {
    const { runtime } = fixture({ mode: "edit", allowedModes: ["plan"] });
    await applyRuntimeExecutionState(runtime, { mode: "yolo" }, fallbackCommand);
    expect(runtime.config.mode).toBe("edit");
  });

  it("drops a request to enable plan when the policy disables plan", async () => {
    const { runtime, appendEvent } = fixture({ allowedModes: ["build", "guarded"] });
    await applyRuntimeExecutionState(runtime, { planEnabled: true }, fallbackCommand);
    expect(runtime.config.planEnabled).toBe(false);
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("still lets plan be turned off when the policy disables plan", async () => {
    // 恢复出的例外：上次开着 Plan，策略此时已禁 Plan。关掉它永远允许。
    const { runtime, appendEvent } = fixture({ planEnabled: true, allowedModes: ["build"] });
    await applyRuntimeExecutionState(runtime, { planEnabled: false }, rejectCommand);
    expect(runtime.config).toEqual({ mode: "build", planEnabled: false });
    expect(appendEvent).toHaveBeenCalledOnce();
  });

  it("normalizes sync config writes to the fallback mode", () => {
    const { runtime } = fixture({ allowedModes: ["build", "plan"] });
    updateConfig.call(runtime, { mode: "yolo" });
    expect(runtime.config.mode).toBe("build");
    const { runtime: planRuntime } = fixture({ allowedModes: ["build"] });
    updateConfig.call(planRuntime, { planEnabled: true });
    expect(planRuntime.config.planEnabled).toBe(false);
  });

  it("leaves sync config writes alone when nothing is restricted", () => {
    const { runtime } = fixture();
    updateConfig.call(runtime, { mode: "yolo", planEnabled: true });
    expect(runtime.config).toEqual({ mode: "yolo", planEnabled: true });
  });

  it("rejects the permission dialog's full-access grant for a disabled mode", async () => {
    const { runtime } = fixture({ allowedModes: ["build"] });
    await expect(grantPermissionMode.call(runtime, "permission-1", "yolo")).rejects.toBeInstanceOf(
      ManagedPolicyModeError,
    );
    await expect(grantPermissionMode.call(runtime, "permission-1", "guarded")).rejects.toThrow(
      /'guarded' is disabled/,
    );
    expect(runtime.config.mode).toBe("build");
  });
});
