import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigScope, type ManagedPolicy } from "@zcode/contracts";
import {
  createConfig,
  getDefaultManagedConfigPath,
  readManagedConfig,
} from "../src/config/index.js";
import { createPrioritizedConfig, mergeConfigs } from "../src/config/config-merger.js";

// 规格见 docs/design/v2/enterprise-managed-policy.md（企业版改造点 T1）。

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-managed-config-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withManagedFile(
  content: string | Record<string, unknown>,
  run: (input: { dir: string; managedConfigPath: string }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const managedConfigPath = join(dir, "managed-config.json");
    await writeFile(
      managedConfigPath,
      typeof content === "string" ? content : JSON.stringify(content),
      "utf8",
    );
    await run({ dir, managedConfigPath });
  });
}

/** 隔离一切与本测试无关的来源：不读用户目录，不看环境变量，不读项目配置。 */
function isolatedPaths(managedConfigPath: string) {
  return {
    env: {},
    skipUserConfig: true,
    managedConfigPath,
  };
}

describe("managed config: locating the file", () => {
  it("uses the system location an administrator owns, per platform", () => {
    expect(getDefaultManagedConfigPath("darwin", {})).toBe(
      "/Library/Application Support/ZCode/managed-config.json",
    );
    expect(getDefaultManagedConfigPath("linux", {})).toBe("/etc/zcode/managed-config.json");
    expect(getDefaultManagedConfigPath("win32", { ProgramData: "D:\\ProgramData" })).toBe(
      "D:\\ProgramData\\ZCode\\managed-config.json",
    );
    expect(getDefaultManagedConfigPath("win32", {})).toBe(
      "C:\\ProgramData\\ZCode\\managed-config.json",
    );
  });
});

describe("managed config: reading the file", () => {
  it("reports absent when there is no managed file", async () => {
    await withTempDir(async (dir) => {
      const managedConfigPath = join(dir, "does-not-exist.json");
      expect(readManagedConfig({ managedConfigPath })).toEqual({ status: "absent" });
    });
  });

  it("reports active with the normalized policy and the path it came from", async () => {
    await withManagedFile(
      {
        version: 1,
        permission: {
          disallowedTools: [" Bash ", "WebFetch", "Bash"],
          allowedModes: ["build", "plan"],
        },
      },
      async ({ managedConfigPath }) => {
        const state = readManagedConfig({ managedConfigPath });
        expect(state).toEqual({
          status: "active",
          path: managedConfigPath,
          policy: {
            permission: { disallowedTools: ["Bash", "WebFetch"], allowedModes: ["build", "plan"] },
          },
          unknownKeys: [],
        });
      },
    );
  });

  it("treats a file with nothing restricted as managed but unrestricted", async () => {
    await withManagedFile({ version: 1 }, async ({ managedConfigPath }) => {
      const state = readManagedConfig({ managedConfigPath });
      expect(state.status).toBe("active");
      if (state.status !== "active") return;
      const policy: ManagedPolicy = state.policy;
      expect(policy.permission.disallowedTools).toEqual([]);
      expect(policy.permission.allowedModes).toBeUndefined();
    });
  });

  it.each([
    ["not JSON", "{ not json", /JSON/],
    ["an empty object", {}, /version/],
    ["a future version", { version: 2 }, /version/],
    ["a version of the wrong type", { version: "1" }, /version/],
    ["a version that is unknown today", { version: 1.5 }, /version/],
    ["a wrong type for the tool list", { version: 1, permission: { disallowedTools: "Bash" } }, /disallowedTools/],
    ["an empty tool name", { version: 1, permission: { disallowedTools: ["Bash", "  "] } }, /disallowedTools/],
    ["a content rule where a tool name is expected", { version: 1, permission: { disallowedTools: ["Bash(git:*)"] } }, /not a tool name/],
    ["a missing disallowedTools entry type", { version: 1, permission: { disallowedTools: [42] } }, /disallowedTools/],
    ["an empty mode list", { version: 1, permission: { allowedModes: [] } }, /allowedModes/],
    ["the reserved auto mode", { version: 1, permission: { allowedModes: ["build", "auto"] } }, /allowedModes/],
    ["an unknown mode", { version: 1, permission: { allowedModes: ["turbo"] } }, /allowedModes/],
    ["a wrong type for permission", { version: 1, permission: [] }, /permission/],
    ["a file that is not an object", "[1, 2, 3]", /object/],
  ] as const)("reports invalid for %s", async (_label, content, reason) => {
    await withManagedFile(content, async ({ managedConfigPath }) => {
      const state = readManagedConfig({ managedConfigPath });
      expect(state.status, JSON.stringify(state)).toBe("invalid");
      expect(state).toMatchObject({ status: "invalid", path: managedConfigPath });
      if (state.status !== "invalid") return;
      expect(state.reason).toMatch(reason);
    });
  });

  it("ignores keys it does not recognize and reports them", async () => {
    await withManagedFile(
      {
        version: 1,
        futureSection: { anything: true },
        permission: { disallowedTools: ["Bash"], futureRule: [] },
      },
      async ({ managedConfigPath }) => {
        const state = readManagedConfig({ managedConfigPath });
        expect(state.status).toBe("active");
        expect(state).toMatchObject({
          policy: { permission: { disallowedTools: ["Bash"] } },
          unknownKeys: ["futureSection", "permission.futureRule"],
        });
      },
    );
  });
});

describe("managed config inside createConfig", () => {
  /** 不给受管路径的那次调用：它读系统默认位置，本机上没有受管文件。 */
  function withoutManagedFile() {
    return createConfig({ env: {}, skipUserConfig: true });
  }

  it("changes nothing when there is no managed file", async () => {
    await withTempDir(async (dir) => {
      const result = createConfig(isolatedPaths(join(dir, "does-not-exist.json")));
      expect(result.managed).toEqual({ status: "absent" });
      // 来源信息与合并结果都与没有受管来源时相同。
      const baseline = withoutManagedFile();
      expect(baseline.managed).toEqual({ status: "absent" });
      const { managed: _ours, ...ours } = result;
      const { managed: _baseline, ...rest } = baseline;
      expect(ours).toEqual(rest);
    });
  });

  it("exposes an active policy without touching any other source", async () => {
    await withManagedFile(
      { version: 1, permission: { disallowedTools: ["Bash"], allowedModes: ["build"] } },
      async ({ managedConfigPath }) => {
        const result = createConfig(isolatedPaths(managedConfigPath));
        expect(result.managed).toMatchObject({
          status: "active",
          path: managedConfigPath,
          policy: { permission: { disallowedTools: ["Bash"], allowedModes: ["build"] } },
        });
        // 除了受管来源本身，其余一切与没有受管文件时相同。
        const baseline = withoutManagedFile();
        expect(result.config).toEqual(baseline.config);
        expect(result.sources).toEqual(baseline.sources);
      },
    );
  });

  it("pins only the listed keys: a managed permission section does not reset the user's permission keys", async () => {
    // 上游的合并是整段替换。受管层若照搬，只写 disallowedTools 就会把用户的 mode 重置成默认值。
    await withManagedFile({ version: 1, permission: { disallowedTools: ["Bash"] } }, async ({ dir, managedConfigPath }) => {
      const userConfigPath = join(dir, "user.json");
      await writeFile(userConfigPath, JSON.stringify({ permission: { mode: "edit" } }), "utf8");
      const result = createConfig({ env: {}, userConfigPath, managedConfigPath });

      // 受管的禁用走专门的通道（result.managed），不并进普通的 disallowedTools。
      expect(result.config.permission).toEqual({
        mode: "edit",
        allowedTools: [],
        disallowedTools: [],
        autoApproveHighRisk: false,
        allowMediumRiskInAuto: false,
      });
      expect(result.managed).toMatchObject({
        status: "active",
        policy: { permission: { disallowedTools: ["Bash"] } },
      });
    });
  });

  it("does not throw on an invalid file and keeps loading the other sources", async () => {
    // createConfig 有三十多处调用，很多只想要默认的存储目录；拒绝启动是创建应用那一步的事。
    await withManagedFile("{ broken", async ({ dir, managedConfigPath }) => {
      const userConfigPath = join(dir, "user.json");
      await writeFile(userConfigPath, JSON.stringify({ permission: { mode: "edit" } }), "utf8");
      const result = createConfig({ env: {}, userConfigPath, managedConfigPath });

      expect(result.managed).toMatchObject({ status: "invalid", path: managedConfigPath });
      expect(result.config.permission.mode).toBe("edit");
    });
  });

  it("is not user config: skipUserConfig leaves the managed source alone", async () => {
    await withManagedFile({ version: 1, permission: { disallowedTools: ["Bash"] } }, async ({ managedConfigPath }) => {
      const result = createConfig({ env: {}, skipUserConfig: true, managedConfigPath });
      expect(result.managed).toMatchObject({
        status: "active",
        policy: { permission: { disallowedTools: ["Bash"] } },
      });
    });
  });

  it("never writes the managed file back", async () => {
    await withManagedFile({ version: 1, permission: { disallowedTools: ["Bash"] } }, async ({ managedConfigPath }) => {
      const before = await stat(managedConfigPath);
      const contentBefore = await readFile(managedConfigPath, "utf8");

      readManagedConfig({ managedConfigPath });
      createConfig(isolatedPaths(managedConfigPath));
      createConfig(isolatedPaths(managedConfigPath));

      const after = await stat(managedConfigPath);
      expect(await readFile(managedConfigPath, "utf8")).toBe(contentBefore);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ino).toBe(before.ino);
    });
  });
});

describe("managed config: scope priority", () => {
  it("lets a managed patch beat CLI overrides in the generic merger, whichever order they arrive in", () => {
    // 受管的键实际上不经过通用合并（走各自的通道）；这里只固定“受管高于 Cli”这条次序本身。
    const cli = createPrioritizedConfig({ permission: { mode: "edit" } }, ConfigScope.Cli);
    const managed = createPrioritizedConfig({ permission: { mode: "build" } }, ConfigScope.Managed);

    expect(mergeConfigs(cli, managed).permission?.mode).toBe("build");
    expect(mergeConfigs(managed, cli).permission?.mode).toBe("build");
  });
});
