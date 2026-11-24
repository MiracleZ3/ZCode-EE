import { describe, expect, it } from "vitest";
import { ConfigScope, ConfigScopePriority, MANAGED_POLICY_VERSION } from "../src/config/index.js";
import {
  resolveManagedPermissionMode,
  type CollaborationMode,
} from "../src/interfaces/session.port.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T1、T3）。

describe("managed policy: scope priority (T1)", () => {
  it("registers the managed scope above every user-controlled scope", () => {
    expect(ConfigScope.Managed).toBe("managed");
    expect(ConfigScopePriority[ConfigScope.Managed]).toBe(100);
    for (const scope of [
      ConfigScope.System,
      ConfigScope.User,
      ConfigScope.Project,
      ConfigScope.Session,
      ConfigScope.Env,
      ConfigScope.Cli,
    ] as const) {
      expect(ConfigScopePriority[ConfigScope.Managed], scope).toBeGreaterThan(ConfigScopePriority[scope]);
    }
  });

  it("pins the managed file schema version", () => {
    expect(MANAGED_POLICY_VERSION).toBe(1);
  });
});

describe("managed policy: mode fallback (T3)", () => {
  const unrestricted: readonly CollaborationMode[] | undefined = undefined;

  it("leaves every mode alone when the policy does not restrict modes", () => {
    for (const mode of ["plan", "build", "edit", "guarded", "yolo", "auto"] as const) {
      expect(resolveManagedPermissionMode(mode, unrestricted)).toBe(mode);
      expect(resolveManagedPermissionMode(mode, [])).toBe(mode);
    }
  });

  it("keeps a mode the policy allows", () => {
    expect(resolveManagedPermissionMode("yolo", ["build", "yolo"])).toBe("yolo");
    expect(resolveManagedPermissionMode("plan", ["plan", "guarded"])).toBe("plan");
  });

  it("falls back to build when build is allowed", () => {
    expect(resolveManagedPermissionMode("yolo", ["build", "plan"])).toBe("build");
    expect(resolveManagedPermissionMode("guarded", ["build", "plan", "edit"])).toBe("build");
  });

  it("falls back to the strictest allowed mode when build itself is not allowed", () => {
    // 严格度次序：plan > build > edit > guarded > yolo。
    // 请求的模式都不在允许列表里，build 也都不在其中。
    expect(resolveManagedPermissionMode("edit", ["guarded", "yolo"])).toBe("guarded");
    expect(resolveManagedPermissionMode("build", ["yolo", "edit"])).toBe("edit");
    expect(resolveManagedPermissionMode("guarded", ["plan", "yolo"])).toBe("plan");
  });

  it("never lets the reserved auto mode through a restricting policy", () => {
    expect(resolveManagedPermissionMode("auto", ["yolo"])).toBe("yolo");
    expect(resolveManagedPermissionMode("auto", ["build"])).toBe("build");
  });
});
