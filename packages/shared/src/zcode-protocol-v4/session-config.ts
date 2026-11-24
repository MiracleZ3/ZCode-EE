import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import { submissionModeSchema } from "./submission.js";

// ── config──
export const sessionConfigStateSchema = z.object({
  /** Session 接受并持久化的稀疏选择意图；provider/model/thought 仅为 UI effective 投影。 */
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // 思考档位是当前模型的能力，不是 workspace/UI 偏好。
  // default 仅用于兼容旧快照；新 agent 必须从 runtime 投影实际集合。
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // additive（冻结面演进，同 meta 的裁决口径）：agent 协作模式（core CollaborationMode）。
  // 必须带 default 才不破坏旧快照/旧发送端的解析；投影经 SessionModeChanged 事件更新。
  mode: z.string().default("build"),
  planEnabled: z.boolean().optional(),
  /**
   * 企业受管策略（改造点 T2）：组织的策略允许哪些模式，由运行时在创建会话时给出。
   * 必须是可选的：旧快照与旧发送端都没有这个键，缺省表示没有受管限制。
   * 界面只读这一个字段，不读受管文件；规格见
   * apps/zcode-cli/docs/design/v2/enterprise-managed-policy.md 的“协议”。
   */
  managedAllowedModes: z.array(submissionModeSchema).optional(),
  /** 明确审批结果；草稿按 interactionId 消费一次，普通 mode 更新不重置它。 */
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /** 最近工具转换的关联，供草稿定向同步；不新增可见历史事件。 */
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;
