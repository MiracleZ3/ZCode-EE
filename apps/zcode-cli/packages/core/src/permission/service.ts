// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  isAmendWorkflowOwnedPredecessor,
  isFillWorkflowHoleOwnedRun,
  PermissionCapabilityGroup,
  type PermissionCapabilityGroup as PermissionCapabilityGroupType,
  type PermissionOptionsPolicy,
  type PermissionRuleValue,
  type PermissionRuleset,
  type PermissionUpdate,
  type CollaborationMode,
  type ModelToolSideEffectScope,
  type RiskLevel,
  type ToolPermissionSpec,
  resolveManagedPermissionMode,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import { resolvePlanModeTransitionPermission } from "./plan-mode-policy.js";
import { webFetchRuleSubjects, wildcardToRegExp } from "./rule-matching.js";
import { isPreapprovedWorkflowDraftWrite } from "./workflow-draft-path.js";
import { applyPermissionUpdates } from "../tool/executor/permission-rules.js";
import { isWebFetchPreapprovedUrl } from "../tool/webfetch-preapproved.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";

// -----------------------------------------------
// Types
// -----------------------------------------------

/** 草稿免确认的规则号。 */
const WORKFLOW_DRAFT_PREAPPROVED_RULE_ID = "tool.workflowDraft.preapproved";

/**
 * 企业受管策略拒绝整个工具时的规则号（改造点 T3）。
 * 故意用一个全新的名字：下游有按规则号字面判断是否放宽的地方，不能与任何现有的规则号撞上。
 */
const MANAGED_DENY_RULE_ID = "rule.managed.deny";

const noManagedDisallowedTools: ReadonlySet<string> = new Set();

/**
 * 用户显式要求进入一个被组织的受管策略禁掉的模式或 Plan（改造点 T2）。
 *
 * 带 `reasonCode`：v4 网关把带 reasonCode 的领域错误原样放进失败的 ACK，客户端才能按码分流；
 * 其余调用方（TUI、旧协议）直接显示消息。
 */
export class ManagedPolicyModeError extends Error {
  readonly reasonCode = "policy.managedModeDisabled";

  constructor(
    readonly mode: CollaborationMode,
    readonly allowedModes: readonly CollaborationMode[],
  ) {
    const allowed = allowedModes.join(", ");
    super(
      mode === "plan"
        ? `Plan mode is disabled by the organization's managed policy. Allowed modes: ${allowed}.`
        : `Mode '${mode}' is disabled by the organization's managed policy. Allowed modes: ${allowed}.`,
    );
    this.name = "ManagedPolicyModeError";
  }
}

/**
 * `disallowedTools` 拒绝整个工具时模型看到的文字（2026-11-14，原来是 `Tool X is explicitly disallowed`）。
 * 项目权限规则的拒绝可能只针对部分输入（路径、命令），文字不变，不能说成整个工具被拒绝。
 */
function toolDeniedMessage(toolName: string): string {
  return `Permission to use ${toolName} has been denied.`;
}

export interface PermissionContext {
  toolName: string;
  input: unknown;
  riskLevel: RiskLevel;
  mode: CollaborationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<CollaborationMode, "plan">;
  /**
   * 会话工作目录。判定相对路径的落点用（目前只有 workflow 草稿免确认这一条），
   * 可选：拿不到工作目录的调用方照常按其余规则判定，不会因此少一层确认。
   */
  workingDirectory?: string;
}

export interface PermissionToolCapability {
  userApprovalRule?: string;
  allowedInPlanMode?: boolean;
  alwaysAsk?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  requiresUserInteraction?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  riskLevel?: RiskLevel;
  needsApproval?: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permission?: ToolPermissionSpec;
}

export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionDecisionResult {
  approvalMode?: "user-once";
  /** 判定自带的询问选项策略，覆盖工具声明的策略（Plan 下的 MCP 询问不提供始终允许）。 */
  optionsPolicy?: PermissionOptionsPolicy;
  decision: PermissionBehavior;
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  escalated: boolean;
  mode: CollaborationMode;
  ruleId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  /**
   * 该 ask 来自工具的 alwaysAsk 声明，不是模式或规则推导出来的。下游（PreToolUse hook 的
   * allow 覆盖）靠这个结构化标记识别"不可抹掉的确认"，而不是去匹配 ruleId 字符串。
   */
  alwaysAsk?: boolean;
}

// -----------------------------------------------
// Permission Service
// -----------------------------------------------

export class PermissionService {
  /**
   * 会话级 allow 规则（「Always allow in this session」）。
   * 一个实例 = 一个 app = 一个会话，所以"随会话消亡"不需要任何额外机制：重启 / 冷恢复 / `/new`
   * 都会造一个空的新实例。只服务 alwaysAsk gate（见 checkAlwaysAsk），普通工具的模式语义不认它。
   */
  private sessionRules: PermissionRuleset = { version: 1 };

  private readonly managedDisallowedTools: ReadonlySet<string>;
  private readonly managedAllowedModes: readonly CollaborationMode[] | undefined;

  constructor(private config: PermissionConfig = defaultPermissionConfig) {
    this.managedDisallowedTools = config.managedDisallowedTools ?? noManagedDisallowedTools;
    this.managedAllowedModes = config.managedAllowedModes;
  }

  /**
   * 组织的受管策略允许哪些协作模式；没有限制时是 `undefined`（改造点 T2）。
   *
   * 执行状态的写入点与协议层都从这里读同一个事实，不各自再去解析受管文件。
   */
  allowedModes(): readonly CollaborationMode[] | undefined {
    return this.managedAllowedModes;
  }

  grantSessionPermission(updates: PermissionUpdate[]): void {
    this.sessionRules = applyPermissionUpdates(this.sessionRules, updates);
  }

  /**
   * 只带受管约束的一份配置（改造点 T3）。
   *
   * 给那种必须沿用组织策略、却不该继承主会话普通名单的子运行时用。它们今天用的是不带任何名单的
   * 默认配置，这里保持这一点不变，只把管理员下发的约束带上。
   */
  managedOnlyConfig(): PermissionConfig {
    return {
      allowedTools: new Set(),
      disallowedTools: new Set(),
      autoApproveHighRisk: false,
      allowMediumRiskInAutoMode: false,
      ...(this.managedDisallowedTools.size > 0
        ? { managedDisallowedTools: new Set(this.managedDisallowedTools) }
        : {}),
      ...(this.managedAllowedModes ? { managedAllowedModes: [...this.managedAllowedModes] } : {}),
    };
  }

  checkPermission(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const capability = this.resolveCapability(context, toolCapability);

    // 企业受管策略（T3）。规格见 docs/design/v2/enterprise-managed-policy.md。
    // 上游的顺序里，Plan 闸门、guarded 的危险命令确认、yolo/guarded 的放行都排在 disallowedTools
    // 与项目 deny 之前，所以普通工具的禁用在这两个模式下完全不生效。管理员下发的禁用不能被任何
    // 模式越过，因此放在最前面，并且结果是 deny：只有 deny 不会被项目 allow、会话授权、
    // PreToolUse Hook 的 allow 或审批应答解除。
    if (this.managedDisallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        MANAGED_DENY_RULE_ID,
        `Permission to use ${context.toolName} has been denied by the organization's managed policy`,
      );
    }
    // 当前模式不在受管允许列表里时，本次判定按回退模式进行。能设置模式的入口有二十多个，
    // 但权限判定只有这一个汇合点，所以约束放在这里才对所有入口生效；下面的分支看到的都是回退模式。
    const effectiveMode = resolveManagedPermissionMode(context.mode, this.managedAllowedModes);
    if (effectiveMode !== context.mode) {
      context = { ...context, mode: effectiveMode };
    }
    const planModeTransition = resolvePlanModeTransitionPermission(context);

    if (planModeTransition) {
      return planModeTransition.behavior === "allow"
        ? this.allow(context, capability, planModeTransition.ruleId, planModeTransition.reason)
        : this.deny(context, capability, planModeTransition.ruleId, planModeTransition.reason);
    }

    if (capability.requiresUserInteraction) {
      if (this.config.disallowedTools.has(context.toolName)) {
        return this.deny(
          context,
          capability,
          "rule.disallowedTools",
          toolDeniedMessage(context.toolName),
        );
      }

      return this.ask(
        context,
        capability,
        "tool.userInteraction",
        `Tool ${context.toolName} requires user interaction`,
      );
    }

    // 独立 Plan 优先于 Guarded 的 YOLO 基础策略，审批不能解除 Plan 的执行限制。
    const planEnabled = context.planEnabled ?? context.mode === "plan";
    if (!planEnabled && context.mode === "guarded" && toolCapability?.userApprovalRule) {
      return this.guardedSingleUseAsk(context, capability, toolCapability.userApprovalRule);
    }

    // 保留 staging 的工具级确认，不被 Guarded 普通调用的 YOLO 基础策略跳过。
    if (capability.alwaysAsk) {
      return this.checkAlwaysAsk(context, capability, projectRules, rulePolicy);
    }

    if ((context.mode === "yolo" || context.mode === "guarded") && !planEnabled) {
      return this.allow(context, capability, "mode.yolo", "Yolo mode bypasses permission prompts");
    }

    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }

    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        toolDeniedMessage(context.toolName),
      );
    }

    if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }

    if (this.matchesProjectRules(projectRules, "ask", context, capability, rulePolicy)) {
      return this.ask(
        context,
        capability,
        "rule.project.ask",
        `Tool ${context.toolName} requires approval by project permission rules`,
      );
    }

    // 原会话回复的接收范围由 Host 再次校验；network 副作用不能让这个免审批契约重新弹窗。
    // 放在显式 deny/ask 之后，且同时匹配内置工具名和能力，不能扩大其他网络工具的权限。
    if (
      context.toolName === "ReplyToChannel" &&
      capability.permissionName === "channel.reply" &&
      capability.sideEffectScope === "network" &&
      capability.riskLevel === "medium" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "tool.channelReply.preapproved",
        "The originating bot conversation is already authorized",
      );
    }

    if (planEnabled) {
      const planDecision = this.checkPlanMode(context, capability);
      if (planDecision?.decision === "deny") return planDecision;
      // 修复原因：上方 guarded 单次确认带 !planEnabled，开着 Plan 时被整个跳过，下方又补回 guarded
      // 放行；危险命令规则一旦匹配到能通过闸门的工具，guarded + Plan 就会免确认执行。
      // 闸门没拒绝时在这里补做单次确认，Plan 的拒绝仍优先。
      if (context.mode === "guarded" && toolCapability?.userApprovalRule) {
        return this.guardedSingleUseAsk(context, capability, toolCapability.userApprovalRule);
      }
      if (planDecision) return planDecision;
      // 闸门放过后按原模式判定；yolo/guarded 的放行在上方因 planEnabled 被跳过，这里补回。
      if (context.mode === "yolo" || context.mode === "guarded") {
        return this.allow(
          context,
          capability,
          "mode.yolo",
          "Yolo mode bypasses permission prompts",
        );
      }
    }

    if (this.matchesProjectRules(projectRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.project.allow",
        `Tool ${context.toolName} is allowed by project permission rules`,
      );
    }

    if (this.isPreapprovedWebFetchRequest(context)) {
      return this.allow(
        context,
        capability,
        "tool.webfetch.preapproved",
        "WebFetch URL is preapproved",
      );
    }

    // 根因：needsApproval=false 不会越过 build/edit 对 workspace 副作用的通用询问，
    // 导致无人值守的 automation 执行轮停在审批界面。该工具无模型可控 id，只能暂停
    // Host 为本轮注入且用户可恢复的任务；显式 project deny/ask 与 plan 限制已在上方处理。
    if (
      context.toolName === "CronPauseSelf" &&
      capability.permissionName === "automation.pause" &&
      capability.sideEffectScope === "workspace" &&
      capability.riskLevel === "low" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "tool.automationPauseSelf.preapproved",
        "The current automation run may pause only its own automation",
      );
    }

    // workflow 草稿免确认：
    // 与 WebFetch 预批同一位次——排在 plan 分支之后，因为 plan 模式必须继续拦下一切写入，
    // 草稿也是写入；也排在项目 deny / ask 之后，项目规则照样压得过它。判定本身见
    // workflow-draft-path.ts（含"为什么这样放行是安全的"）。
    if (
      isPreapprovedWorkflowDraftWrite({
        input: context.input,
        toolName: context.toolName,
        workingDirectory: context.workingDirectory,
      })
    ) {
      return this.allow(
        context,
        capability,
        WORKFLOW_DRAFT_PREAPPROVED_RULE_ID,
        "Workflow draft file is preapproved",
      );
    }

    if (this.config.allowedTools.has(context.toolName)) {
      return this.allow(
        context,
        capability,
        "rule.allowedTools",
        `Tool ${context.toolName} is explicitly allowed`,
      );
    }

    if (capability.permission?.confirmationHandledByTool) {
      return this.allow(
        context,
        capability,
        "tool.explicitConfirmation",
        "Tool collects explicit confirmation before mutations",
      );
    }
    if (context.mode === "edit") {
      return this.checkEditMode(context, capability);
    }

    return this.checkBuildMode(context, capability);
  }

  private matchesProjectRules(
    ruleset: PermissionRuleset | null | undefined,
    behavior: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    rulePolicy?: ToolPermissionRulePolicy,
  ): boolean {
    const rules = ruleset?.[behavior];
    if (!Array.isArray(rules)) return false;
    const toolRules = rules.filter((rule) =>
      this.matchesRuleScope(rule, context.toolName, capability),
    );
    if (toolRules.length === 0) return false;
    if (rulePolicy) return rulePolicy.evaluateRules(behavior, toolRules);
    return toolRules.some((rule) => this.matchesRule(rule, context, capability));
  }

  private matchesRule(
    rule: PermissionRuleValue,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (!this.matchesRuleScope(rule, context.toolName, capability)) return false;
    if (!rule.ruleContent) return true;

    const subjects = this.ruleSubjects(context.input, context.toolName);
    if (subjects.length === 0) return false;

    return subjects.some((subject) => this.matchesRuleContent(subject, rule.ruleContent!));
  }

  private matchesRuleToolName(ruleToolName: string, contextToolName: string): boolean {
    if (ruleToolName === contextToolName) return true;
    return contextToolName === "Write" && ruleToolName === "Edit";
  }

  private matchesRuleScope(
    rule: PermissionRuleValue,
    contextToolName: string,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME) {
      // 保留 key 只有在当前 tool entry 另行携带宿主验证后的 official_cua
      // capability 时才匹配。同名第三方 MCP、authority 漂移以及旧普通 tool
      // 都不能把可解析的 wire/storage 字符串升级成可信能力。
      return capability.permissionCapabilityGroup === PermissionCapabilityGroup.OfficialCua;
    }
    return this.matchesRuleToolName(rule.toolName, contextToolName);
  }

  private ruleSubjects(input: unknown, toolName: string): string[] {
    if (typeof input === "string") return [input];
    if (!input || typeof input !== "object") return [];

    const record = input as Record<string, unknown>;
    if (toolName === "WebFetch" && typeof record.url === "string") {
      return webFetchRuleSubjects(record.url);
    }

    for (const key of ["command", "url", "file_path", "path", "pattern", "patch_text"]) {
      const value = record[key];
      if (typeof value === "string") return [value];
    }

    return [];
  }

  private isPreapprovedWebFetchRequest(context: PermissionContext): boolean {
    if (context.toolName !== "WebFetch") return false;
    if (!context.input || typeof context.input !== "object") return false;
    const url = (context.input as Record<string, unknown>).url;
    return typeof url === "string" && isWebFetchPreapprovedUrl(url);
  }

  private matchesRuleContent(subject: string, ruleContent: string): boolean {
    if (ruleContent.endsWith(":*")) {
      const prefix = ruleContent.slice(0, -2);
      return (
        subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
      );
    }

    if (ruleContent.includes("*")) {
      return wildcardToRegExp(ruleContent).test(subject);
    }

    return subject === ruleContent;
  }

  /**
   * 工具自报 alwaysAsk 时的判定：ask 压过所有"放行"分支（yolo 直通、plan 的 readOnly 直通），
   * 但**压不过"阻断"**——所以这里先自己走一遍硬阻断判定。
   *
   * 为什么不直接返回 ask：disallowedTools 是用户配置的硬禁用，项目 deny 规则符合工具自报的
   * denyPriority: "beforeAsk"，auto 模式是"该模式未实现"的保护。少了这一步，一个被硬禁用的
   * 工具会退化成"弹个窗、用户一点就能跑"。
   *
   * 这些判定在 checkPermission 里按原有顺序还会各自出现一次；此处刻意只覆盖 alwaysAsk 工具，
   * 不改动其他工具的既有优先级（尤其 yolo 目前先于 disallowedTools 放行这一点）。
   */
  private checkAlwaysAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }
    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        toolDeniedMessage(context.toolName),
      );
    }
    if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }
    // 会话免确认：阻断分支之后、ask 之前。命中即放行，不发 permission 事件、不弹窗；
    // 与 gate 本身一样不看模式（yolo / plan / build 一致）。
    if (this.matchesProjectRules(this.sessionRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.session.allow",
        `Tool ${context.toolName} was allowed for this session`,
      );
    }
    // 修订免确认：AmendWorkflow 的前驱是
    // **本会话发起**的 run、不是用户亲手停下的、且这次修订没有引入新 provider，即放行。与会话规则同位——阻断分支之后、ask 之前，
    // 不看模式。事实来自 resolveInput 回填的 `predecessor`（journal 的 parent_session_id / stopReason），
    // 不是内存表：重启、冷恢复后依然成立，也没有可播种、可撤销的东西。别的会话的 run、用户停过的
    // run 照常 ask：钥匙是 run 的归属，不是字段的在场。
    if (this.isOwnedWorkflowAmend(context)) {
      return this.allow(
        context,
        capability,
        "rule.session.workflowOwner",
        `Tool ${context.toolName} amends a run this session started`,
      );
    }
    return this.ask(
      context,
      capability,
      "tool.alwaysAsk",
      `Tool ${context.toolName} always requires explicit approval`,
    );
  }

  /**
   * AmendWorkflow 且回填的 `predecessor` 说「本会话的 run、非用户停下」；或 FillWorkflowHole 且回填的
   * `hole` 说同一件事（docs/dynamic-workflow/launch.md「Approval」：补全是对一个在飞 run 脚本的修订，
   * 由同一条 amend 规则判定）。
   */
  private isOwnedWorkflowAmend(context: PermissionContext): boolean {
    if (!context.input || typeof context.input !== "object") return false;
    const input = context.input as Record<string, unknown>;
    // 谓词本体住在契约里：就地调并发落回修订时读的必须是同一条规则，不能各写一遍。
    if (context.toolName === AMEND_WORKFLOW_TOOL_NAME) {
      return isAmendWorkflowOwnedPredecessor(input.predecessor);
    }
    if (context.toolName === FILL_WORKFLOW_HOLE_TOOL_NAME) {
      return isFillWorkflowHoleOwnedRun(input.hole);
    }
    return false;
  }

  /** Guarded 危险命令的单次确认：不提供始终允许，确认只对这一次执行有效。 */
  private guardedSingleUseAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
  ): PermissionDecisionResult {
    return {
      ...this.ask(
        context,
        capability,
        ruleId,
        "Dangerous command requires your approval for this execution",
      ),
      approvalMode: "user-once",
    };
  }

  /**
   * Plan 闸门：只在原模式之上收紧。返回 undefined 表示放过，由调用方继续按原模式判定。
   */
  private checkPlanMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult | undefined {
    // 原模式对只读免审批工具同样放行，这里直接放行只为保留 ruleId。
    if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
      return this.allow(
        context,
        capability,
        "mode.plan.readOnly",
        "Plan mode allows read-only tool execution",
      );
    }

    // 修复原因：这里曾对只读工具不看 needsApproval、对非 destructive MCP 直接放行，Plan 因此比
    // 原模式更宽（任意 URL 的 WebFetch、MCP 写工具、node_repl 的 js 都免审批），而 EnterPlanMode
    // 本身免确认。现在需审批的只读工具（WebFetch、readOnlyHint MCP）只过闸，交给原模式判定。
    if (capability.readOnly && !capability.destructive) return undefined;

    if (this.isMcpToolCapability(capability) && !capability.destructive) {
      if (context.mode === "yolo" || context.mode === "guarded") return undefined;
      // 询问排在 allow 规则之前，规则不能跳过；Plan 下记住的规则不会生效，所以不提供始终允许。
      return {
        ...this.ask(
          context,
          capability,
          "mode.plan.mcp",
          "Plan mode requires approval for MCP tools that are not read-only",
        ),
        optionsPolicy: "no-always-allow",
      };
    }

    if (
      capability.allowedInPlanMode &&
      capability.sideEffectScope === "session" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.plan.explicitSessionCapability",
        "Plan mode allows this explicit non-destructive session control action",
      );
    }

    return this.deny(
      context,
      capability,
      "mode.plan.nonReadOnly",
      "Plan mode only allows read-only, non-destructive tools",
    );
  }

  private isMcpToolCapability(capability: ResolvedPermissionCapability): boolean {
    return capability.permissionName === "mcp";
  }

  private checkBuildMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
      return this.allow(
        context,
        capability,
        "mode.build.readOnly",
        "Build mode allows read-only tools",
      );
    }

    if (capability.riskLevel === "critical") {
      return this.ask(
        context,
        capability,
        "mode.build.criticalRisk",
        "Critical risk tools require explicit approval",
      );
    }

    if (capability.riskLevel === "high" && !this.config.autoApproveHighRisk) {
      return this.ask(
        context,
        capability,
        "mode.build.highRisk",
        "High risk tools require explicit approval",
      );
    }

    if (
      capability.sideEffectScope === "session" &&
      capability.riskLevel === "low" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.build.sessionState",
        "Build mode allows low-risk session-local state updates",
      );
    }

    if (
      capability.needsApproval ||
      capability.destructive ||
      capability.sideEffectScope !== "none"
    ) {
      return this.ask(
        context,
        capability,
        "mode.build.sideEffect",
        "Tool has side effects and requires approval",
      );
    }

    return this.allow(
      context,
      capability,
      "mode.build.lowRisk",
      "Build mode allows low-risk tool execution",
    );
  }

  private checkEditMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.permissionName === "edit" && capability.sideEffectScope === "workspace") {
      return this.allow(
        context,
        capability,
        "mode.edit.fileEdit",
        "Edit mode allows file edit tools",
      );
    }

    return this.checkBuildMode(context, capability);
  }

  requiresApproval(context: PermissionContext, toolCapability?: PermissionToolCapability): boolean {
    const decision = this.checkPermission(context, toolCapability);
    return decision.decision === "ask";
  }

  getRiskLevel(toolName: string, toolCapability?: PermissionToolCapability): RiskLevel {
    if (toolCapability?.riskLevel) {
      return toolCapability.riskLevel;
    }

    if (this.isReadOnlyTool(toolName)) {
      return "low";
    }

    if (this.isWriteTool(toolName)) {
      return "medium";
    }

    if (this.isDestructiveTool(toolName)) {
      return "high";
    }

    return "medium";
  }

  private isReadOnlyTool(name: string): boolean {
    return new Set([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "TodoRead",
      "TodoWrite",
      "AskUserQuestion",
      "Agent",
      "Task",
      "Skill",
    ]).has(name);
  }

  private isWriteTool(name: string): boolean {
    return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
  }

  private isDestructiveTool(name: string): boolean {
    return new Set(["Bash"]).has(name);
  }

  private resolveCapability(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
  ): ResolvedPermissionCapability {
    return {
      allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
      alwaysAsk: toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false,
      readOnly: toolCapability?.readOnly ?? this.isReadOnlyTool(context.toolName),
      destructive: toolCapability?.destructive ?? this.isDestructiveTool(context.toolName),
      requiresUserInteraction:
        toolCapability?.requiresUserInteraction ??
        (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
          "userInteraction",
      sideEffectScope:
        toolCapability?.permission?.sideEffectScope ??
        toolCapability?.sideEffectScope ??
        (this.isReadOnlyTool(context.toolName) ? "none" : "workspace"),
      riskLevel:
        toolCapability?.permission?.riskLevel ??
        this.getRiskLevel(context.toolName, toolCapability),
      needsApproval:
        toolCapability?.permission?.needsApproval ??
        toolCapability?.needsApproval ??
        !this.isReadOnlyTool(context.toolName),
      permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
      permissionName: toolCapability?.permission?.permission,
      permission: toolCapability?.permission,
    };
  }

  private allow(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return this.result("allow", context, capability, ruleId, reason);
  }

  private ask(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("ask", context, capability, ruleId, reason);
  }

  private deny(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("deny", context, capability, ruleId, reason);
  }

  private result(
    decision: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return {
      decision,
      allowed: decision === "allow",
      escalated: decision === "ask",
      mode: context.mode,
      reason,
      riskLevel: capability.riskLevel,
      ruleId,
      sideEffectScope: capability.sideEffectScope,
      ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
    };
  }
}

interface ResolvedPermissionCapability {
  permission?: ToolPermissionSpec;
  allowedInPlanMode: boolean;
  alwaysAsk: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresUserInteraction: boolean;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permissionName?: string;
}

// -----------------------------------------------
// Configuration
// -----------------------------------------------

export interface PermissionConfig {
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
  autoApproveHighRisk: boolean;
  allowMediumRiskInAutoMode: boolean;
  /**
   * 企业受管策略（改造点 T1、T3）：被管理员禁用的工具。先于一切模式放行与规则判定。
   * 与上面的 disallowedTools 是两条通道——那个键在上游的语义是“yolo 下可越过”，这里不是。
   */
  managedDisallowedTools?: ReadonlySet<string>;
  /** 企业受管策略：允许的权限模式。缺省表示不受限制。不在列表里的模式在判定时按回退模式处理。 */
  managedAllowedModes?: readonly CollaborationMode[];
}

export const defaultPermissionConfig: PermissionConfig = {
  allowedTools: new Set(),
  disallowedTools: new Set(),
  autoApproveHighRisk: false,
  allowMediumRiskInAutoMode: false,
};
