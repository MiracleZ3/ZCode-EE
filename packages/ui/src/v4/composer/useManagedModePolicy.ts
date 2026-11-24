// 企业受管策略下的模式草稿（改造点 T2）。规格：docs/ui/managed-mode-selector.md。
//
// “哪些模式被禁”只有一份事实：运行时写在会话快照的 config.managedAllowedModes 里。这里只读它，
// 不读受管文件，也不另存一份。菜单本身的置灰与标注在 V4ComposerModeControls 里。
import { useCallback, useEffect } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";

export interface ManagedModePolicyParams {
  /** 面板当前看到的会话快照。只认属于 expectedSessionId 的那一份。 */
  snapshot: ConversationSnapshot | null;
  /** 这份草稿对应的会话：绑定的会话、恢复中的草稿或预热会话。没有时为 null。 */
  expectedSessionId: string | null;
  composerDraft: { mode?: string; planEnabled?: boolean } | null | undefined;
  onSwitchMode: (mode: string) => void;
}

/** 会话当前的权限模式。Plan 在运行时是独立的开关，不是一种权限模式。 */
function sessionPermissionMode(mode: string | undefined): string | undefined {
  const parsed = submissionModeSchema.safeParse(mode);
  return parsed.success && parsed.data !== "plan" ? parsed.data : undefined;
}

/** 先用会话当前的模式；它不可用时依次试 build 和策略允许的其余权限。 */
function replacementMode(
  sessionMode: string | undefined,
  managedAllowedModes: readonly string[] | undefined,
): string | undefined {
  return [sessionMode, "build", ...(managedAllowedModes ?? []).filter((mode) => mode !== "plan")].find(
    (mode) => mode !== undefined && managedAllowedModes?.includes(mode),
  );
}

/**
 * 1. 草稿里残留着被禁的模式时归正成会话当前的模式——“最近使用”记住的可能是上次的“完全访问”，
 *    或者策略是在界面打开期间生效的。不归正的话，发送时运行时只能按回退模式执行，
 *    而界面上还显示着被禁的那一个。
 * 2. 交给菜单的切换回调只放弃被禁的模式。置灰已经挡住了鼠标与键盘，这里是给其它调用方的保险。
 *
 * 草稿的模式仍然是“下一次提交的意图”，这里不向运行时发任何命令。
 */
export function useManagedModePolicy({
  snapshot,
  expectedSessionId,
  composerDraft,
  onSwitchMode,
}: ManagedModePolicyParams): (mode: string) => void {
  // 别的会话的快照不说明这份草稿受什么限制。按字符串比较，所以先放宽成 string 数组。
  const belongsToDraft = snapshot !== null && snapshot.sessionId === expectedSessionId;
  const managedAllowedModes: readonly string[] | undefined = belongsToDraft
    ? snapshot?.config.managedAllowedModes
    : undefined;
  const sessionMode = belongsToDraft ? sessionPermissionMode(snapshot?.config.mode) : undefined;

  const draftMode = composerDraft?.mode;
  const draftPlanEnabled = composerDraft?.planEnabled ?? false;
  const restricted = managedAllowedModes !== undefined;
  const planForbidden = restricted && !managedAllowedModes.includes("plan");
  const modeForbidden =
    restricted &&
    draftMode !== undefined &&
    draftMode !== "plan" &&
    !managedAllowedModes.includes(draftMode);

  useEffect(() => {
    if (planForbidden && draftPlanEnabled) onSwitchMode("plan-off");
  }, [draftPlanEnabled, onSwitchMode, planForbidden]);

  useEffect(() => {
    if (!modeForbidden) return;
    const replacement = replacementMode(sessionMode, managedAllowedModes);
    if (replacement !== undefined && replacement !== draftMode) onSwitchMode(replacement);
  }, [draftMode, managedAllowedModes, modeForbidden, onSwitchMode, sessionMode]);

  return useCallback(
    (mode: string) => {
      // 没有受管限制时原样放行，与改动前相同。plan-off 只是关掉 Plan，永远允许。
      if (managedAllowedModes && mode !== "plan-off" && !managedAllowedModes.includes(mode)) return;
      onSwitchMode(mode);
    },
    [managedAllowedModes, onSwitchMode],
  );
}
