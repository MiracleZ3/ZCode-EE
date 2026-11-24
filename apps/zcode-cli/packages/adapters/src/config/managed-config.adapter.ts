// 企业版受管策略文件的读取（改造点 T1）。
// 规格见 docs/design/v2/enterprise-managed-policy.md。
//
// 与 file-config.adapter 里的各来源刻意分开：那边的加载器读取时可能因旧插件迁移而写盘，
// 而受管文件是管理员的，任何情况下都不能被人改写；那边“解析失败就跳过”，这边则要把失败如实报出来。

import { readFileSync } from "node:fs";
import type { ManagedPolicy } from "@zcode/contracts";
import type { z } from "zod";
import { ManagedPolicyFileSchema } from "./schema.js";

/**
 * 受管来源在下一次配置装配时的状态。
 *
 * - absent：没有受管文件，一切与上游相同。
 * - active：文件有效。`unknownKeys` 是文件里不认识的键，已被忽略。
 * - invalid：文件存在但不可用。`createConfig` 不因此抛错（它有很多调用方只需要别的值），
 *   创建应用时要据此拒绝启动。
 */
export type ManagedConfigState =
  | { status: "absent" }
  | { status: "active"; path: string; policy: ManagedPolicy; unknownKeys: readonly string[] }
  | { status: "invalid"; path: string; reason: string };

const MANAGED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["version", "permission"]);
const MANAGED_PERMISSION_KEYS: ReadonlySet<string> = new Set(["disallowedTools", "allowedModes"]);

/**
 * 受管文件的默认位置：由管理员拥有、普通用户只读的系统位置。
 *
 * 路径只能由程序的调用方经 `managedConfigPath` 指定，不提供环境变量或命令行开关：
 * 那两样用户可控，等于给受管来源留后门。`platform` 与 `env` 是给测试注入用的。
 */
export function getDefaultManagedConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    // Windows 的系统级目录没有不依赖原生模块的取法，沿用系统环境变量 ProgramData，缺失时取常规位置。
    // 用户可以为自己的进程改写这个变量；这一点由 T6 的策略签名校验兜住，不在这里处理。
    const programData = env.ProgramData?.trim() || "C:\\ProgramData";
    return `${programData}\\ZCode\\managed-config.json`;
  }
  if (platform === "darwin") {
    return "/Library/Application Support/ZCode/managed-config.json";
  }
  return "/etc/zcode/managed-config.json";
}

/** 读取并校验受管文件。同步读取，与配置工厂里其他来源的读取方式一致；不写回任何内容。 */
export function readManagedConfig(options: { managedConfigPath?: string } = {}): ManagedConfigState {
  const path = options.managedConfigPath ?? getDefaultManagedConfigPath();
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "invalid", path, reason: `The managed policy file cannot be read (${code ?? "unknown error"}).` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      status: "invalid",
      path,
      reason: `The managed policy file is not valid JSON: ${(error as Error).message}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", path, reason: "The managed policy file must be a JSON object." };
  }
  // 上面的检查已确认它是非 null、非数组的对象，这里只是补上索引签名。
  const record = parsed as Record<string, unknown>;

  const result = ManagedPolicyFileSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { status: "invalid", path, reason: `The managed policy file does not match the expected shape: ${details}` };
  }

  const policy = normalizePolicy(result.data);
  return { status: "active", path, policy, unknownKeys: collectUnknownKeys(record) };
}

/**
 * 把校验后的内容整理成固定的形状：禁用列表去重（首尾空白已由 schema 去掉）；
 * 可用模式未写时不补默认值，缺省就表示不受限制。
 */
function normalizePolicy(file: z.infer<typeof ManagedPolicyFileSchema>): ManagedPolicy {
  return {
    permission: {
      disallowedTools: [...new Set(file.permission?.disallowedTools ?? [])],
      ...(file.permission?.allowedModes ? { allowedModes: [...file.permission.allowedModes] } : {}),
    },
  };
}

/** 文件里不认识的键。忽略它们是为了让管控平面新增限制时旧客户端不至于无法启动。 */
function collectUnknownKeys(parsed: Record<string, unknown>): string[] {
  const unknownKeys: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (MANAGED_TOP_LEVEL_KEYS.has(key)) continue;
    unknownKeys.push(key);
  }
  const permission = parsed.permission;
  if (typeof permission === "object" && permission !== null && !Array.isArray(permission)) {
    for (const key of Object.keys(permission)) {
      if (MANAGED_PERMISSION_KEYS.has(key)) continue;
      unknownKeys.push(`permission.${key}`);
    }
  }
  return unknownKeys;
}
