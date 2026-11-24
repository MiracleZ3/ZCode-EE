// 企业受管策略下模式菜单的表现（改造点 T2）。规格见 docs/ui/managed-mode-selector.md。
// URL 参数：allowed=build,plan 表示组织允许哪些模式，缺省表示不受限；mode、plan 是草稿初值。
// surface=policy 换成面板块那一层（useManagedModePolicy）的最小接入。
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ModelSelectionView } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import { useManagedModePolicy } from "@/v4/composer/useManagedModePolicy.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const allowed = params.get("allowed");
const managedAllowedModes = allowed ? allowed.split(",") : undefined;
const services = {
  settingService: { get: async () => ({}) },
  broadcastService: { onMessage: () => ({ dispose() {} }) },
  projectService: { readProjects: async () => [] },
  modelSelectionService: {
    getView: async () =>
      ({ revision: 1, providers: [], providerTemplates: [] }) as unknown as ModelSelectionView,
    onDidChange: () => ({ dispose() {} }),
  },
} as unknown as IServiceAccessor;

function MenuFixture() {
  const [mode, setMode] = useState(params.get("mode") ?? "build");
  const [planEnabled, setPlan] = useState(params.get("plan") === "on");
  const [picker, setPicker] = useState<"mode" | null>(null);
  const [commits, setCommits] = useState(0);
  // 与真实接入相同：组件只改草稿，不向运行时发命令。
  const switchMode = useCallback((next: string) => {
    setCommits((count) => count + 1);
    if (next === "plan" || next === "plan-off") setPlan(next === "plan");
    else setMode(next);
  }, []);
  return (
    <main className="min-h-dvh bg-background p-3 text-foreground">
      <V4ComposerModeSwitch
        workspacePath="/example"
        draftConfig={{ mode, planEnabled }}
        managedAllowedModes={managedAllowedModes}
        activeConfigPicker={picker}
        onConfigPickerOpenChange={(_picker, open) => setPicker(open ? "mode" : null)}
        onSwitchMode={switchMode}
      />
      <output className="sr-only" data-testid="state">
        {JSON.stringify({ mode, planEnabled, commits })}
      </output>
      <ConfirmDialogHost />
    </main>
  );
}

type Draft = { mode?: string; planEnabled?: boolean };

function PolicyFixture() {
  const [composerDraft, setComposerDraft] = useState<Draft>({
    mode: params.get("mode") ?? "build",
    planEnabled: params.get("plan") === "on",
  });
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  // 与 useDraftConfigControl 的 handleDraftSwitchMode 相同的落盘规则。
  const onSwitchMode = useCallback((next: string) => {
    if (next === "plan" || next === "plan-off")
      setComposerDraft((current) => ({
        ...current,
        mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
        planEnabled: next === "plan",
      }));
    else setComposerDraft((current) => ({ ...current, mode: next }));
  }, []);
  const switchMode = useManagedModePolicy({
    snapshot,
    expectedSessionId: "sess_1",
    composerDraft,
    onSwitchMode,
  });
  Object.assign(window, {
    publishPolicy: (sessionId: string, mode: string, allowed?: string[]) =>
      setSnapshot({
        sessionId,
        config: { mode, ...(allowed ? { managedAllowedModes: allowed } : {}) },
      } as unknown as ConversationSnapshot),
    requestSwitch: switchMode,
  });
  return (
    <main className="min-h-dvh bg-background p-3 text-foreground">
      <output className="sr-only" data-testid="state">
        {JSON.stringify(composerDraft)}
      </output>
      <ConfirmDialogHost />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={{} as IPlatformService}>
      <ZCodeIntlProvider initialLocale={(params.get("locale") ?? "zh-CN") as never}>
        <TabStoreProvider>
          <TooltipProvider>
            {params.get("surface") === "policy" ? <PolicyFixture /> : <MenuFixture />}
          </TooltipProvider>
        </TabStoreProvider>
      </ZCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
