import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { assertManagedPolicyUsable, resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T1）的“有效与无效”一节。

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

  it("leaves the session mode alone when the policy does not restrict modes", async () => {
    // 本提交只加入受管的配置来源；按策略限制模式的判定属于改造点 T3。
    const path = await managedFile(JSON.stringify({ version: 1, permission: { disallowedTools: ["Bash"] } }));
    const configResult = createConfig({ env: {}, skipUserConfig: true, managedConfigPath: path, workingDirectory });
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult,
      options: { runtimeConfig: { mode: "yolo" } },
      mcpConfiguration: {},
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.mode).toBe("yolo");
  });
});
