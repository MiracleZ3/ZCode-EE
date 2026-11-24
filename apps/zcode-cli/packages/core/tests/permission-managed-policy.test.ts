import { describe, expect, it } from "vitest";
import type { PermissionRuleset, PermissionUpdate } from "@zcode/contracts";
import {
  PermissionService,
  type PermissionConfig,
  type PermissionContext,
  type PermissionToolCapability,
} from "../src/permission/service.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T3）。
// 上游的行为不变：普通 disallowedTools 在 yolo 下仍被越过（见 permission-service.test.ts）。
// 这里测的是受管通道，它先于一切模式放行。

const MANAGED_DENY = "rule.managed.deny";

const bashWrite: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "workspace",
};

const readCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: false,
  readOnly: true,
  riskLevel: "low",
  sideEffectScope: "none",
};

/** guarded 模式下会上报“危险命令”规则的 Bash 调用。 */
const dangerousBash: PermissionToolCapability = {
  ...bashWrite,
  destructive: true,
  riskLevel: "high",
  sideEffectScope: "system",
  userApprovalRule: "safety.bash.managed-policy-test",
};

function bash(mode: PermissionContext["mode"], planEnabled?: boolean): PermissionContext {
  return {
    input: { command: "echo hello" },
    mode,
    riskLevel: "medium",
    toolName: "Bash",
    ...(planEnabled === undefined ? {} : { planEnabled }),
  };
}

type ManagedFields = Pick<PermissionConfig, "managedDisallowedTools" | "managedAllowedModes">;

function baseConfig(): PermissionConfig {
  return {
    allowedTools: new Set(),
    disallowedTools: new Set(),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  };
}

function managedService(managed: ManagedFields, extra: Partial<PermissionConfig> = {}) {
  return new PermissionService({ ...baseConfig(), ...extra, ...managed });
}

/** 再给一条会话授权，于是“项目 allow、会话授权、allowedTools”三条放行路都通。 */
function grantSession(service: PermissionService, toolName: string): void {
  const update: PermissionUpdate = { type: "addRules", behavior: "allow", rules: [{ toolName }] };
  service.grantSessionPermission([update]);
}

const projectAllow: PermissionRuleset = { version: 1, allow: [{ toolName: "Bash" }] };

describe("managed policy: deny ahead of everything else (T3)", () => {
  const denyBash = managedService({ managedDisallowedTools: new Set(["Bash"]) });

  it.each([
    ["build", undefined],
    ["edit", undefined],
    ["yolo", undefined],
    ["guarded", undefined],
    ["guarded", true],
    ["plan", undefined],
    ["plan", true],
  ] as const)("denies a managed tool in %s mode (planEnabled=%s)", (mode, planEnabled) => {
    const decision = denyBash.checkPermission(bash(mode, planEnabled), bashWrite);

    expect(decision).toMatchObject({ allowed: false, decision: "deny", ruleId: MANAGED_DENY });
    expect(decision).not.toHaveProperty("approvalMode");
  });

  it("answers a forbidden tool with deny, not the guarded single-use approval", () => {
    // guarded 的危险命令确认在普通 disallowedTools 之前返回 ask；受管禁用必须排在它前面。
    const decision = denyBash.checkPermission(bash("guarded"), dangerousBash);

    expect(decision).toMatchObject({ allowed: false, decision: "deny", ruleId: MANAGED_DENY });
    expect(decision).not.toHaveProperty("approvalMode");
  });

  it("answers a forbidden tool with deny even when the tool always asks", () => {
    const decision = denyBash.checkPermission(bash("yolo"), { ...bashWrite, alwaysAsk: true });

    expect(decision).toMatchObject({ allowed: false, decision: "deny", ruleId: MANAGED_DENY });
  });

  it("is not lifted by project allow rules, session grants, or the allowedTools list", () => {
    const service = managedService({ managedDisallowedTools: new Set(["Bash"]) }, {
      allowedTools: new Set(["Bash"]),
    });
    grantSession(service, "Bash");

    const decision = service.checkPermission(bash("build"), bashWrite, projectAllow);

    expect(decision).toMatchObject({ allowed: false, decision: "deny", ruleId: MANAGED_DENY });
  });

  it("can forbid EnterPlanMode itself, because it is judged ahead of the plan gate", () => {
    const enterPlan = (): PermissionContext => ({
      input: {},
      mode: "build",
      riskLevel: "low",
      toolName: "EnterPlanMode",
    });
    // 上游：进入 Plan 的闸门无条件放行。
    expect(new PermissionService().checkPermission(enterPlan(), readCapability)).toMatchObject({
      allowed: true,
      decision: "allow",
    });

    const service = managedService({ managedDisallowedTools: new Set(["EnterPlanMode"]) });
    expect(service.checkPermission(enterPlan(), readCapability)).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: MANAGED_DENY,
    });
  });

  it("matches whole tool names only, leaving every other tool alone", () => {
    expect(denyBash.checkPermission(bash("yolo"), bashWrite).decision).toBe("deny");

    const read: PermissionContext = { input: { file_path: "/tmp/a" }, mode: "yolo", riskLevel: "low", toolName: "Read" };
    expect(denyBash.checkPermission(read, readCapability)).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "mode.yolo",
    });
  });
});

describe("managed policy: modes the policy forbids (T3)", () => {
  it("judges a forbidden mode as the fallback mode and records that mode on the decision", () => {
    const service = managedService({
      managedDisallowedTools: new Set(),
      managedAllowedModes: ["build"],
    });

    const inForbiddenYolo = service.checkPermission(bash("yolo"), bashWrite);
    const inBuild = service.checkPermission(bash("build"), bashWrite);

    // 上游的 yolo 会直接放行；这里按 build 判定，也就是询问。
    expect(inForbiddenYolo.allowed).toBe(false);
    expect(inForbiddenYolo.decision).toBe("ask");
    expect(inForbiddenYolo.mode).toBe("build");
    expect(inForbiddenYolo).toEqual(inBuild);
  });

  it("does not offer the guarded single-use approval when guarded is forbidden", () => {
    const service = managedService({ managedDisallowedTools: new Set(), managedAllowedModes: ["build"] });

    const inForbiddenGuarded = service.checkPermission(bash("guarded"), dangerousBash);
    const inBuild = service.checkPermission(bash("build"), dangerousBash);

    expect(inForbiddenGuarded).not.toHaveProperty("approvalMode");
    expect(inForbiddenGuarded).toEqual(inBuild);
  });

  it("falls back to the strictest allowed mode when Plan is on, and never widens Plan", () => {
    // 上游在 Plan 开启时同样拒绝写入；回退之后的模式必须仍然拒绝。
    // build 不在允许列表里：允许的是 plan 与 edit，其中更严格的是 plan。
    const service = managedService({ managedDisallowedTools: new Set(), managedAllowedModes: ["plan", "edit"] });
    const upstream = new PermissionService();

    const inForbiddenYolo = service.checkPermission(bash("yolo", true), bashWrite);
    expect(inForbiddenYolo.mode).toBe("plan");
    expect(inForbiddenYolo.decision).toBe("deny");
    expect(upstream.checkPermission(bash("yolo", true), bashWrite).decision).toBe("deny");
  });

  it("falls back to the strictest allowed mode when build is forbidden too", () => {
    const service = managedService({ managedDisallowedTools: new Set(), managedAllowedModes: ["guarded", "yolo"] });

    const inForbiddenBuild = service.checkPermission(bash("build"), dangerousBash);
    const inGuarded = service.checkPermission(bash("guarded"), dangerousBash);

    expect(inForbiddenBuild.mode).toBe("guarded");
    expect(inForbiddenBuild).toEqual(inGuarded);
  });

  it("changes nothing when the policy does not restrict modes", () => {
    const ordinary = { disallowedTools: new Set(["Bash"]) };
    const upstream = new PermissionService({ ...baseConfig(), ...ordinary });
    const underPolicy = new PermissionService({
      ...baseConfig(),
      ...ordinary,
      managedDisallowedTools: new Set(),
      managedAllowedModes: undefined,
    });

    const modes = ["plan", "build", "edit", "guarded", "yolo"] as const;
    const capabilities = [bashWrite, readCapability, dangerousBash];
    for (const mode of modes) {
      for (const capability of capabilities) {
        for (const planEnabled of [undefined, true]) {
          const context = bash(mode, planEnabled);
          expect(underPolicy.checkPermission(context, capability, projectAllow), JSON.stringify({ mode, planEnabled, capability })).toEqual(
            upstream.checkPermission(context, capability, projectAllow),
          );
        }
      }
    }
    // 特别地：普通 disallowedTools 在 yolo 下仍被越过，这是上游的既有语义。
    expect(
      new PermissionService({ ...baseConfig(), managedDisallowedTools: new Set(), ...ordinary }).checkPermission(
        bash("yolo"),
        bashWrite,
      ),
    ).toMatchObject({ allowed: true, decision: "allow", ruleId: "mode.yolo" });
  });
});

describe("managed policy: sub-runtimes inherit it (T3)", () => {
  it("derives a config that carries only the managed restrictions", () => {
    // 项目记忆代理这类子运行时必须沿用组织策略，但不能顺手继承主会话的普通名单。
    const main = managedService(
      { managedDisallowedTools: new Set(["WebFetch"]), managedAllowedModes: ["build"] },
      { allowedTools: new Set(["Bash"]), disallowedTools: new Set(["Read"]) },
    );
    const derivedConfig = main.managedOnlyConfig();

    expect(derivedConfig.allowedTools.size).toBe(0);
    expect(derivedConfig.disallowedTools.size).toBe(0);
    expect(derivedConfig.managedDisallowedTools ? [...derivedConfig.managedDisallowedTools] : []).toEqual(["WebFetch"]);
    expect(derivedConfig.managedAllowedModes).toEqual(["build"]);

    const sub = new PermissionService(derivedConfig);
    const webFetch: PermissionContext = {
      input: { url: "https://example.test" },
      mode: "yolo",
      riskLevel: "medium",
      toolName: "WebFetch",
    };
    expect(sub.checkPermission(webFetch, readCapability)).toMatchObject({
      decision: "deny",
      ruleId: MANAGED_DENY,
    });
    // 主会话的普通名单没有带过来：同一个调用，主会话因为 disallowedTools 拒绝，
    // 子运行时与一个不带任何策略的默认服务判定相同。
    const read: PermissionContext = { input: { file_path: "/tmp/a" }, mode: "build", riskLevel: "low", toolName: "Read" };
    expect(main.checkPermission(read, readCapability).decision).toBe("deny");
    expect(sub.checkPermission(read, readCapability)).toEqual(
      new PermissionService().checkPermission(read, readCapability),
    );
  });

  it("returns no managed restrictions for a service that was built without a policy", () => {
    expect(new PermissionService().managedOnlyConfig()).toEqual({
      allowedTools: new Set(),
      disallowedTools: new Set(),
      autoApproveHighRisk: false,
      allowMediumRiskInAutoMode: false,
    });
  });
});
