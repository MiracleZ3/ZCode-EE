import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { CollaborationMode, Logger, LoggerFactory } from "@zcode/contracts";
import type { PermissionService } from "@zcode/core";
import { resolveEffectiveMcpConfiguration } from "../src/mcp-config.js";
import {
  assertManagedPolicyUsable,
  managedPermissionFields,
  resolveAppRuntimeConfig,
} from "../src/app/runtime-config.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T1、T3）的“启动处的执行”。

const workingDirectory = "/workspace/app";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function managedFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-managed-policy-app-"));
  roots.push(root);
  const path = join(root, "managed-config.json");
  await writeFile(path, content, "utf8");
  return path;
}

/** 只记录警告的日志工厂：解析器在模式回退时记的那条警告要在这里断言。 */
function captureWarnings() {
  const warn = vi.fn();
  const logger: Logger = { debug() {}, info() {}, error() {}, warn, child: () => logger };
  const loggerFactory: LoggerFactory = {
    createLogger: () => logger,
    withContext: () => logger,
    setLevel() {},
  };
  return { loggerFactory, warn };
}

const models = {
  main: { provider: "provider:test", model: "glm-0531", kind: "anthropic", baseURL: "http://old.example.test/v1" },
  lite: { provider: "provider:test", model: "glm-0531-lite", kind: "anthropic", baseURL: "http://old.example.test/v1" },
};

interface ModeInput {
  /** 宿主传入的模式， 即 options.runtimeConfig.mode。 */
  hostMode?: CollaborationMode;
  /** 会话库里按项目保存的模式。 */
  persistedMode?: CollaborationMode;
  /** 配置文件里的 permission.mode。 */
  configMode?: CollaborationMode;
  managedConfigPath?: string;
}

function resolveMode(input: ModeInput) {
  const { loggerFactory, warn } = captureWarnings();
  const configResult = createConfig({
    cliOverrides: {
      model: models,
      ...(input.configMode ? { permission: { mode: input.configMode } } : {}),
    },
    env: {},
    skipUserConfig: true,
    workingDirectory,
    ...(input.managedConfigPath ? { managedConfigPath: input.managedConfigPath } : {}),
  });
  const options = {
    loggerFactory,
    ...(input.hostMode ? { runtimeConfig: { mode: input.hostMode } } : {}),
  };
  const mcp = resolveEffectiveMcpConfiguration({
    enabled: configResult.config.features.mcp,
    servers: configResult.config.mcp.servers,
    explicit: options.runtimeConfig?.mcp,
  });
  const resolved = resolveAppRuntimeConfig({
    cliStorageRoot: "/tmp/zcode-cli",
    configResult,
    mcpConfiguration: mcp.mcp,
    options,
    subagentOutputRootDir: "/tmp/zcode-cli/agents",
    subagentProfiles: [],
    workingDirectory,
    ...(input.persistedMode ? { persistedMode: input.persistedMode } : {}),
  });
  return { mode: resolved.runtimeConfig.mode as CollaborationMode, warn };
}

describe("startup: the managed policy constrains the initial mode (T3)", () => {
  it("leaves the resolved mode alone when there is no managed file", async () => {
    expect(resolveMode({ hostMode: "yolo" }).mode).toBe("yolo");
    expect(resolveMode({ persistedMode: "guarded" }).mode).toBe("guarded");
    expect(resolveMode({ configMode: "edit" }).mode).toBe("edit");
    expect(resolveMode({}).mode).toBe("build");
  });

  it("replaces a forbidden mode with the fallback, wherever the mode came from", async () => {
    const path = await managedFile(JSON.stringify({
      version: 1,
      permission: { allowedModes: ["build", "plan"] },
    }));

    expect(resolveMode({ managedConfigPath: path, hostMode: "yolo" }).mode).toBe("build");
    expect(resolveMode({ managedConfigPath: path, persistedMode: "guarded" }).mode).toBe("build");
    expect(resolveMode({ managedConfigPath: path, configMode: "edit" }).mode).toBe("build");
    // 被允许的模式保持原样；已有的优先级（宿主 > 项目偏好 > 配置）不变。
    expect(resolveMode({ managedConfigPath: path, hostMode: "plan", persistedMode: "yolo" }).mode).toBe("plan");
    // 没有限制模式的受管文件不改变模式。
    const unrestricted = await managedFile(JSON.stringify({
      version: 1,
      permission: { disallowedTools: ["Bash"] },
    }));
    expect(resolveMode({ managedConfigPath: unrestricted, hostMode: "yolo" }).mode).toBe("yolo");
  });

  it("falls back to the strictest allowed mode when build is forbidden", async () => {
    const path = await managedFile(JSON.stringify({
      version: 1,
      permission: { allowedModes: ["guarded", "yolo"] },
    }));

    expect(resolveMode({ managedConfigPath: path }).mode).toBe("guarded");
  });

  it("warns with the requested and effective mode when it falls back, and stays silent otherwise", async () => {
    const path = await managedFile(JSON.stringify({
      version: 1,
      permission: { allowedModes: ["build", "plan"] },
    }));

    const fellBack = resolveMode({ managedConfigPath: path, hostMode: "yolo" });
    expect(fellBack.warn).toHaveBeenCalledTimes(1);
    expect(fellBack.warn.mock.calls[0]?.[1]).toMatchObject({
      event: "bootstrap.app.startup.managed_policy_mode_fallback",
      requestedMode: "yolo",
      effectiveMode: "build",
      managedPolicyPath: path,
    });

    expect(resolveMode({ managedConfigPath: path, hostMode: "build" }).warn).not.toHaveBeenCalled();
    expect(resolveMode({ hostMode: "yolo" }).warn).not.toHaveBeenCalled();
  });
});

describe("startup: an unusable managed file", () => {
  it("blocks startup with the path and the reason", async () => {
    const path = await managedFile("{ broken");
    const managed = createConfig({ env: {}, skipUserConfig: true, managedConfigPath: path }).managed;

    expect(managed.status).toBe("invalid");
    expect(() => assertManagedPolicyUsable(managed)).toThrow(/managed policy file is invalid/);
    expect(() => assertManagedPolicyUsable(managed)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(() => assertManagedPolicyUsable(managed)).toThrow(/JSON/);
  });

  it("lets startup through when the file is absent or valid", async () => {
    const { managed } = createConfig({
      env: {},
      skipUserConfig: true,
      // 一个肯定不存在的路径：只需要“文件不存在”，不需要为它建目录。
      managedConfigPath: join(tmpdir(), "zcode-no-managed-policy-here", "missing.json"),
    });
    expect(managed.status).toBe("absent");
    expect(() => assertManagedPolicyUsable(managed)).not.toThrow();

    const path = await managedFile(JSON.stringify({ version: 1, permission: { disallowedTools: ["Bash"] } }));
    const active = createConfig({ env: {}, skipUserConfig: true, managedConfigPath: path }).managed;
    expect(() => assertManagedPolicyUsable(active)).not.toThrow();
  });

  it("makes the real app factory refuse to start", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-managed-policy-factory-"));
    roots.push(root);
    const path = await managedFile(JSON.stringify({ version: 7 }));

    const creation = createRegistryBackedTestApp({
      env: { ZCODE_HOME: root },
      skipUserConfig: true,
      sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
      providerRegistry: createTestProviderRegistry([{ providerId: "test", modelId: "model" }]),
      managedConfigPath: path,
      runtimeConfig: { mcp: { enabled: false, servers: {} }, workingDirectory: root },
    });

    await expect(creation).rejects.toThrow(/managed policy file is invalid/);
    await expect(creation).rejects.toThrow(/version/);
  });
});

describe("startup: the policy reaches the runtime", () => {
  it("hands the managed restrictions to the permission service and starts in an allowed mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-managed-policy-live-"));
    roots.push(root);
    const path = await managedFile(JSON.stringify({
      version: 1,
      permission: { disallowedTools: ["WebFetch"], allowedModes: ["build", "plan"] },
    }));

    const app = await createRegistryBackedTestApp({
      env: { ZCODE_HOME: root },
      skipUserConfig: true,
      sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
      providerRegistry: createTestProviderRegistry([{ providerId: "test", modelId: "model" }]),
      managedConfigPath: path,
      // 宿主要求 yolo，但策略不允许：应用从一开始就在回退模式上。
      runtimeConfig: { mcp: { enabled: false, servers: {} }, mode: "yolo", workingDirectory: root },
    });

    expect(app.getMode()).toBe("build");
    const service = (app.runtime as unknown as { permissionService: PermissionService }).permissionService;
    expect(service.managedOnlyConfig()).toMatchObject({
      managedDisallowedTools: new Set(["WebFetch"]),
      managedAllowedModes: ["build", "plan"],
    });
  });
});

describe("managedPermissionFields", () => {
  it("maps an active policy onto the service's managed fields", async () => {
    const path = await managedFile(JSON.stringify({
      version: 1,
      permission: { disallowedTools: ["Bash"], allowedModes: ["build"] },
    }));
    const { managed } = createConfig({ env: {}, skipUserConfig: true, managedConfigPath: path });

    expect(managedPermissionFields(managed)).toEqual({
      managedDisallowedTools: new Set(["Bash"]),
      managedAllowedModes: ["build"],
    });
  });

  it("adds no managed fields when there is no managed file", () => {
    const { managed } = createConfig({ env: {}, skipUserConfig: true, workingDirectory });

    expect(managed.status).toBe("absent");
    expect(managedPermissionFields(managed)).toEqual({});
  });
});
