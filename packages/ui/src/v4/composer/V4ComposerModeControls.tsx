import { modeTriggerColor } from "@/chat-input-toolbar/display-help.js";
import { memo, useCallback, useMemo } from "react";
import { LightbulbIcon, XIcon, ChevronDownIcon } from "lucide-react";
import {
  ZCODE_AGENT_PROVIDER,
  getZCodeAgentAvailableModes,
  type ZCodeConfigOption,
} from "@zcode/shared";
import {
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CHAT_MODE_SELECT_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { RollingToolbarLabel } from "@/chat-input-toolbar/RollingToolbarLabel.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  getModeOptionDisplayLabel,
  getModeOptionDescriptionMessageId,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useYoloModeConfirmation } from "@/hooks/useConfirmDialog.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  getNextConfigSelectValue,
  useToolbarShortcutBindings,
} from "@/v4/composer/toolbarShortcuts.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

function noop(): void {}

/**
 * 一个模式在组织的受管策略下能不能选（改造点 T2）。没有受管限制时都能选，走的还是原来的路径。
 * 规格：docs/ui/managed-mode-selector.md。
 */
function isModeAllowedByPolicy(mode: string, managedAllowedModes?: readonly string[]): boolean {
  return !managedAllowedModes || managedAllowedModes.includes(mode);
}

/** 三种权限，Plan 另有独立的勾选项。目录是固定的，在模块级算一次，引用稳定。 */
const permissionModes = getZCodeAgentAvailableModes().filter((mode) => mode.id !== "plan");

/**
 * 被禁候选的原因，写在原来的说明文字位置。
 *
 * 常驻可见：禁用的行收不到悬停事件，原因不能只放在悬停提示里。颜色沿用说明文字，不跟着标题一起
 * 弱化——用户最需要读懂的恰恰是这一句。不加图标：菜单只有 256 像素宽，文字要占满这一行。
 */
function PolicyLockedNote() {
  const { intl } = useZCodeIntl();
  return (
    <span className="text-ui-sm text-foreground-subtle">
      {intl.formatMessage({ id: "chat.toolbar.mode.managedByOrganization" })}
    </span>
  );
}

/** Plan 是独立勾选项，三种权限仍为单选；只编辑草稿，不向 Runtime 发切换命令。 */
function V4ComposerModeSwitchImpl({
  provider,
  draftConfig,
  managedAllowedModes,
  disabled,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSwitchMode,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
> & {
    /** 组织的受管策略允许哪些模式；缺省表示不受限（改造点 T2）。来自会话快照的 config。 */
    managedAllowedModes?: readonly string[];
  }) {
  const { intl } = useZCodeIntl();
  // 原草稿回调随 scope 换代，旧确认不能把权限写入后来选中的任务。
  const confirmMode = useYoloModeConfirmation(disabled ? null : onSwitchMode, draftConfig?.mode);
  const requestSwitchMode = useCallback(
    (mode: string) => {
      // 被禁的候选在这里再拦一次：置灰已经挡住鼠标与键盘，这里挡住程序触发的切换
      // （循环快捷键的候选已经排除它们，这里是保险）。
      if (!isModeAllowedByPolicy(mode, managedAllowedModes)) return;
      confirmMode(mode, () => onSwitchMode(mode));
    },
    [confirmMode, managedAllowedModes, onSwitchMode],
  );
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const modeShortcutLabel = useShortcutCommandLabel("cycleSessionMode");
  const modes = getZCodeAgentAvailableModes();
  const permissions = permissionModes;
  const planAllowed = isModeAllowedByPolicy("plan", managedAllowedModes);
  // 新菜单隐藏 Edit，但历史草稿仍可回显，不能因候选变化隐藏整个权限入口。
  const selected =
    permissions.find((mode) => mode.id === draftConfig?.mode) ??
    (draftConfig?.mode === "edit" ? { id: "edit", name: "Edit" } : undefined);
  const label = (mode: (typeof modes)[number]) =>
    getModeOptionDisplayLabel(intl, displayProvider, { value: mode.id, name: mode.name });
  const plan = modes.find((mode) => mode.id === "plan")!;
  const planLabel = label(plan);
  // Plan 拆成独立勾选项后仍需保留原菜单说明，复用相同的国际化映射。
  const planDescriptionId = getModeOptionDescriptionMessageId(displayProvider, { value: plan.id });
  // 菜单仍然列出被禁的候选（用户需要知道有这个模式、为什么不能用），
  // 但循环快捷键不经过它们：这里给快捷键的候选表只含允许的权限。
  const modeOption = useMemo<ZCodeConfigOption>(
    () => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: draftConfig?.mode ?? "build",
      options: permissions
        .filter((mode) => isModeAllowedByPolicy(mode.id, managedAllowedModes))
        .map((mode) => ({ value: mode.id, name: mode.name })),
    }),
    [draftConfig?.mode, managedAllowedModes, permissions],
  );
  const cycle = useCallback(() => {
    const next = getNextConfigSelectValue(modeOption);
    if (next) requestSwitchMode(next);
  }, [modeOption, requestSwitchMode]);
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(selected),
    toolbarDisabled: disabled,
    modelMenuDisabled: true,
    modeOption,
    onCycleSessionMode: cycle,
    onOpenModelMenu: noop,
    onCycleThoughtLevel: noop,
  });
  if (!selected) return null;
  const Icon = resolveModeOptionIcon(selected.id);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu
        open={activeConfigPicker === "mode"}
        onOpenChange={(open) => onConfigPickerOpenChange("mode", open)}
      >
        <ControlHintTooltip
          title={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
          shortcut={modeShortcutLabel}
          open={activeConfigPicker === "mode" ? false : undefined}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
              data-composer-collapse-priority="1"
              aria-label={intl.formatMessage({ id: "chat.toolbar.mode.label" })}
              className={cn(
                "group/mode h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0",
                modeTriggerColor(selected.id),
              )}
            >
              <Icon className="size-4" />
              <span className="inline group-data-[composer-compact=true]/mode:hidden">
                {/* Plan 菜单重写时普通 span 丢失了旧 ConfigSelect 的翻滚；复用同一动画组件恢复。 */}
                <RollingToolbarLabel label={label(selected)} />
              </span>
              <ChevronDownIcon className="size-3.5 group-data-[composer-compact=true]/mode:hidden" />
            </Button>
          </DropdownMenuTrigger>
        </ControlHintTooltip>
        <DropdownMenuContent
          side="top"
          sideOffset={4}
          className="w-64"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!useConfirmDialogStore.getState().pendingRequest && !isCoarseTouchDevice())
              document
                .querySelector<HTMLElement>(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`)
                ?.focus();
          }}
        >
          <DropdownMenuCheckboxItem
            checked={draftConfig?.planEnabled ?? false}
            onCheckedChange={(checked) => onSwitchMode(checked ? "plan" : "plan-off")}
            disabled={!planAllowed}
            data-policy-locked={planAllowed ? undefined : "true"}
            data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, "plan")}
            className="min-h-13 items-start gap-3 py-2"
          >
            <LightbulbIcon className="mt-0.5 size-4.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{planLabel}</span>
              {!planAllowed ? <PolicyLockedNote /> : (
                planDescriptionId && (
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: planDescriptionId })}
                  </span>
                )
              )}
            </span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={selected.id} onValueChange={requestSwitchMode}>
            {permissions.map((mode) => {
              const ModeIcon = resolveModeOptionIcon(mode.id);
              const descriptionId = getModeOptionDescriptionMessageId(displayProvider, {
                value: mode.id,
              });
              const locked = !isModeAllowedByPolicy(mode.id, managedAllowedModes);
              return (
                <DropdownMenuRadioItem
                  key={mode.id}
                  value={mode.id}
                  disabled={locked}
                  data-policy-locked={locked ? "true" : undefined}
                  data-testid={testId(TID_CHAT_MODE_SELECT_ITEM, mode.id)}
                  className="min-h-13 items-start gap-3 py-2"
                >
                  <ModeIcon className="mt-0.5 size-4.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{label(mode)}</span>
                    {locked ? <PolicyLockedNote /> : (
                      descriptionId && (
                        <span className="text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({ id: descriptionId })}
                        </span>
                      )
                    )}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {draftConfig?.planEnabled && (
        <span data-testid="v4-composer-plan-marker" className="flex items-center gap-1">
          <span
            role="separator"
            aria-orientation="vertical"
            className="h-3 w-px shrink-0 bg-border"
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "chat.plan.removeMarker" })}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-composer-collapse-priority="2"
              onClick={() => onSwitchMode("plan-off")}
              aria-label={intl.formatMessage({ id: "chat.plan.removeMarker" })}
              className="group/plan h-7 gap-1 rounded-lg px-2 text-ui-base text-foreground-subtle hover:text-foreground-subtle data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
            >
              <LightbulbIcon className="size-4 group-hover/plan:hidden group-focus-visible/plan:hidden" />
              <XIcon className="hidden size-4 group-hover/plan:block group-focus-visible/plan:block" />
              <span className="inline group-data-[composer-compact=true]/plan:hidden">
                {intl.formatMessage({ id: "mode.plan" })}
              </span>
            </Button>
          </ControlHintTooltip>
        </span>
      )}
    </div>
  );
}
export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
