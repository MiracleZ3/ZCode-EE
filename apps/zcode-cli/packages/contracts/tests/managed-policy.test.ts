import { describe, expect, it } from "vitest";
import { ConfigScope, ConfigScopePriority, MANAGED_POLICY_VERSION } from "../src/config/index.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T1）。

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
