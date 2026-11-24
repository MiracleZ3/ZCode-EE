import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { CollaborationMode } from "@zcode/contracts";
import { ManagedPolicyModeError } from "@zcode/core";
import { sessionConfigStateSchema } from "@zcode/shared/zcode-protocol-v4";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T2）的“入口处与界面公布”。

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function managedFile(allowedModes?: readonly CollaborationMode[]): Promise<string | undefined> {
  if (!allowedModes) return undefined;
  const root = await mkdtemp(join(tmpdir(), "zcode-managed-modes-"));
  roots.push(root);
  const path = join(root, "managed-config.json");
  await writeFile(
    path,
    JSON.stringify({ version: 1, permission: { allowedModes } }),
    "utf8",
  );
  return path;
}

async function startApp(input: {
  allowedModes?: readonly CollaborationMode[];
  mode?: CollaborationMode;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-managed-modes-home-"));
  roots.push(root);
  const managedConfigPath = await managedFile(input.allowedModes);
  const app = await createRegistryBackedTestApp({
    env: { ZCODE_HOME: root },
    skipUserConfig: true,
    sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
    providerRegistry: createTestProviderRegistry([{ providerId: "test", modelId: "model" }]),
    ...(managedConfigPath ? { managedConfigPath } : {}),
    runtimeConfig: {
      mcp: { enabled: false, servers: {} },
      // 缺省从 build 起步：T3 已把不被允许的初始模式换成了回退模式。
      ...(input.mode ? { mode: input.mode } : {}),
      workingDirectory: root,
    },
  });
  return app;
}

describe("the app publishes the policy's allowed modes (T2)", () => {
  it("publishes nothing when there is no managed file", async () => {
    const app = await startApp();
    expect(app.getManagedAllowedModes?.()).toBeUndefined();
  });

  it("publishes nothing when the policy does not restrict modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-managed-modes-policy-"));
    roots.push(root);
    const path = join(root, "managed-config.json");
    await writeFile(path, JSON.stringify({ version: 1, permission: { disallowedTools: ["Bash"] } }));
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_HOME: root },
      skipUserConfig: true,
      sessionStore: await createSqliteSessionStore({ dbPath: ":memory:" }),
      providerRegistry: createTestProviderRegistry([{ providerId: "test", modelId: "model" }]),
      managedConfigPath: path,
      runtimeConfig: { mcp: { enabled: false, servers: {} }, workingDirectory: root },
    });
    expect(app.getManagedAllowedModes?.()).toBeUndefined();
  });

  it("publishes the allowed modes of the policy", async () => {
    const app = await startApp({ allowedModes: ["build", "plan"] });
    expect(app.getManagedAllowedModes?.()).toEqual(["build", "plan"]);
  });
});

describe("switching modes under a policy (T2)", () => {
  it("rejects setMode for a disabled mode and keeps the session where it was", async () => {
    const app = await startApp({ allowedModes: ["build", "plan"] });
    await expect(app.setMode("yolo")).rejects.toBeInstanceOf(ManagedPolicyModeError);
    await expect(app.setMode("yolo")).rejects.toThrow(/'yolo' is disabled by the organization's managed policy/);
    expect(app.getMode()).toBe("build");
  });

  it("still allows setMode for an allowed mode", async () => {
    const app = await startApp({ allowedModes: ["build", "guarded", "plan"] });
    await app.setMode("guarded");
    expect(app.getMode()).toBe("guarded");
    await app.setMode("build");
    expect(app.getMode()).toBe("build");
  });

  it("rejects enabling plan when the policy disables plan", async () => {
    const app = await startApp({ allowedModes: ["build", "guarded"] });
    await expect(app.runtime.setExecutionState({ planEnabled: true })).rejects.toBeInstanceOf(
      ManagedPolicyModeError,
    );
    expect(app.runtime.getPlanEnabled()).toBe(false);
  });

  it("turns a declared state onto the fallback mode without failing", async () => {
    const app = await startApp({ allowedModes: ["build", "plan"] });
    await app.runtime.setExecutionState(
      { mode: "yolo", planEnabled: true },
      undefined,
      { managedPolicy: "fallback" },
    );
    expect(app.getMode()).toBe("build");
    expect(app.runtime.getPlanEnabled()).toBe(true);
  });

  it("leaves every entry point unchanged when nothing is restricted", async () => {
    const app = await startApp();
    await app.setMode("yolo");
    expect(app.getMode()).toBe("yolo");
    await app.runtime.setExecutionState({ mode: "build", planEnabled: true });
    expect(app.getMode()).toBe("build");
    expect(app.runtime.getPlanEnabled()).toBe(true);
  });
});

describe("the projection seed carries the allowed modes (T2)", () => {
  function seedFromGateway(allowedModes?: readonly CollaborationMode[]) {
    // 直接取网关从应用读种子的那个钩子：这里要证明的是“应用里的策略 → 种子”这段接线本身。
    const app = {
      sessionId: "sess_1",
      getMode: () => "build",
      ...(allowedModes ? { getManagedAllowedModes: () => allowedModes } : {}),
      runtime: {
        getSessionModelSelection: () => undefined,
        getPlanEnabled: () => false,
        listModels: () => [],
      },
    };
    const context = {
      deps: {},
      sessions: new Map([["sess_1", { app }]]),
    } as unknown as ZCodeProtocolAgentServerContext;
    const gateway = createConversationV4Gateway(context);
    const host = (gateway as unknown as { host: { getSessionConfigSeed(id: string): object } }).host;
    return host.getSessionConfigSeed("sess_1");
  }

  it("reads the allowed modes from the app when the gateway seeds a conversation", () => {
    expect(seedFromGateway(["build", "plan"])).toMatchObject({
      mode: "build",
      managedAllowedModes: ["build", "plan"],
    });
  });

  it("adds no managed key when the app has no restriction, or predates the field", () => {
    expect(seedFromGateway()).not.toHaveProperty("managedAllowedModes");
    expect(seedFromGateway(undefined)).not.toHaveProperty("managedAllowedModes");
  });

  it("writes managedAllowedModes into config, keeps the schema valid and is idempotent", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    projection.seedConfig({ mode: "build", managedAllowedModes: ["build", "plan"] });
    const first = projection.getSnapshot();
    expect(first.config.managedAllowedModes).toEqual(["build", "plan"]);
    expect(sessionConfigStateSchema.parse(first.config).managedAllowedModes).toEqual(["build", "plan"]);

    const revision = first.revision;
    projection.seedConfig({ mode: "build", managedAllowedModes: ["build", "plan"] });
    expect(projection.getSnapshot()).toBe(first);
    expect(projection.getSnapshot().revision).toBe(revision);
  });

  it("keeps the same shape as before when nothing is restricted", () => {
    const plain = new ProductProjection("session-1", "epoch-1");
    plain.seedConfig({ mode: "build" });
    const withEmpty = new ProductProjection("session-1", "epoch-1");
    withEmpty.seedConfig({ mode: "build", managedAllowedModes: undefined });
    expect(Object.hasOwn(withEmpty.getSnapshot().config, "managedAllowedModes")).toBe(false);
    expect(withEmpty.getSnapshot().config).toEqual(plain.getSnapshot().config);
  });

  it("replaces or removes what earlier seeds left behind", () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    projection.seedConfig({ managedAllowedModes: ["build"] });
    projection.seedConfig({ managedAllowedModes: ["build", "guarded"] });
    expect(projection.getSnapshot().config.managedAllowedModes).toEqual(["build", "guarded"]);
    projection.seedConfig({ managedAllowedModes: undefined });
    expect(Object.hasOwn(projection.getSnapshot().config, "managedAllowedModes")).toBe(false);
  });
});
