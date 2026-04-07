import { useAuraStore } from "@renderer/store/useAuraStore";

import { ChatComposer, ChatThread, TaskBanner } from "../ChatThread";
import { AuraLogoBlob, StatusPill } from "../primitives";
import { RuntimeRecoveryBanner } from "../RuntimeRecoveryBanner";
import { Card, InfoTile, SectionHeading } from "../shared";

const normalizeTextContent = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) return String((value as { text: unknown }).text);
  return value ? String(value) : "";
};

const QuickAction = ({
  label,
  detail,
  onClick,
}: {
  label: string;
  detail: string;
  onClick: () => void;
}): JSX.Element => (
  <button
    className="group flex w-full items-start justify-between rounded-[22px] border border-white/5 bg-white/[0.02] px-5 py-4 text-left transition-all hover:-translate-y-0.5 hover:border-white/10 hover:bg-white/[0.04]"
    onClick={onClick}
  >
    <div>
      <p className="text-[14px] font-semibold text-aura-text group-hover:text-white">{label}</p>
      <p className="mt-1 text-[12px] leading-5 text-aura-muted">{detail}</p>
    </div>
    <span className="pt-1 text-aura-muted transition-transform group-hover:translate-x-1">{"->"}</span>
  </button>
);

export const HomePage = (): JSX.Element => {
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const activeMonitorsCount = useAuraStore((state) => state.monitors.filter((monitor) => monitor.status === "active").length);
  const activeTabsCount = useAuraStore((state) => state.browserTabs.length);
  const history = useAuraStore((state) => state.history);
  const profile = useAuraStore((state) => state.profile);
  const setRoute = useAuraStore((state) => state.setRoute);
  const activeBrowserTabId = useAuraStore((state) => state.activeBrowserTabId);
  const messages = useAuraStore((state) => state.messages);
  const activeRun = useAuraStore((state) => state.activeRun);

  const firstName = profile.fullName ? profile.fullName.split(" ")[0] : "there";

  return (
    <div className="mx-auto flex h-full w-full max-w-[1440px] flex-col gap-8 overflow-y-auto pr-2 pb-8">
      <div className="mt-4 flex items-start justify-between gap-6">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-aura-violet">Aura Home</p>
          <h1 className="mt-2 text-[34px] font-bold tracking-tight text-white">
            Welcome back, {firstName}
          </h1>
          <p className="mt-2 max-w-[720px] text-[15px] leading-7 text-aura-muted">
            Start with chat. Aura can browse, automate, and work across your desktop from one conversation while OpenClaw handles the heavy lifting underneath.
          </p>
        </div>
        <div className="hidden items-center gap-3 lg:flex">
          <StatusPill
            label={runtimeStatus.phase === "ready" ? "Engine online" : runtimeStatus.phase}
            tone={runtimeStatus.phase === "ready" ? "success" : runtimeStatus.phase === "error" ? "error" : "warning"}
          />
          {activeRun && <StatusPill label={activeRun.surface} tone="warning" />}
        </div>
      </div>

      <RuntimeRecoveryBanner
        primaryAction={{
          label: "Open Runtime Settings",
          onClick: () => setRoute("settings"),
        }}
      />

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="p-0">
            <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex min-h-[620px] flex-col border-b border-white/6 lg:border-b-0 lg:border-r">
                <div className="border-b border-white/6 px-6 py-5">
                  <SectionHeading
                    title="Chat-First Workspace"
                    detail="Ask naturally, create schedules in conversation, and let Aura show live activity as OpenClaw works."
                  />
                </div>
                <div className="min-h-0 flex-1 px-4 py-4">
                  <ChatThread emptyContext="home" />
                </div>
                <div className="border-t border-white/6 px-4 py-4">
                  <ChatComposer />
                </div>
              </div>

              <div className="flex flex-col gap-4 px-5 py-5">
                <div className="rounded-[24px] border border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.18),transparent_32%),rgba(255,255,255,0.04)] p-5">
                  <div className="flex items-start gap-4">
                    <AuraLogoBlob size="sm" isTaskRunning={Boolean(activeRun)} />
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.18em] text-aura-violet">Conversation mode</p>
                      <p className="mt-2 text-[18px] font-semibold text-aura-text">
                        {messages.length === 0 ? "Ready for a fresh task" : "Continue the current session"}
                      </p>
                      <p className="mt-2 text-[13px] leading-6 text-aura-muted">
                        {messages.length === 0
                          ? "Try reminders, browsing, desktop work, or skill-driven tasks from one input box."
                          : "Aura keeps the active session loaded here so you can continue without hunting through history."}
                      </p>
                    </div>
                  </div>
                </div>

                <TaskBanner />

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                  <InfoTile
                    label="Aura Engine"
                    value={runtimeStatus.phase === "ready" ? "Online" : runtimeStatus.phase}
                    detail={runtimeStatus.message}
                  />
                  <div
                    className="group cursor-pointer rounded-[24px] border border-white/[0.06] bg-white/[0.02] px-5 py-5 transition-all hover:border-white/[0.1] hover:bg-white/[0.04]"
                    onClick={() => void setRoute("browser")}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted transition-colors group-hover:text-aura-text">Built-in Browser</p>
                      <div className={`h-2 w-2 rounded-full ${activeBrowserTabId ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]" : "bg-white/20"}`} />
                    </div>
                    <p className="mt-4 text-[32px] font-bold tracking-tight text-aura-text transition-transform group-hover:translate-x-1">{activeTabsCount}</p>
                    <p className="mt-1 pb-1 text-[13px] text-aura-muted opacity-80">Active tabs in the embedded browser</p>
                  </div>
                  <div
                    className="group cursor-pointer rounded-[24px] border border-white/[0.06] bg-white/[0.02] px-5 py-5 transition-all hover:border-white/[0.1] hover:bg-white/[0.04]"
                    onClick={() => void setRoute("monitors")}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted transition-colors group-hover:text-aura-text">Active Automations</p>
                      <div className={`h-2 w-2 rounded-full ${activeMonitorsCount > 0 ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]" : "bg-white/20"}`} />
                    </div>
                    <p className="mt-4 text-[32px] font-bold tracking-tight text-aura-text transition-transform group-hover:translate-x-1">{activeMonitorsCount}</p>
                    <p className="mt-1 pb-1 text-[13px] text-aura-muted opacity-80">Cron-backed jobs currently enabled</p>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <div className="flex flex-col">
            <SectionHeading title="Recent Task History" detail="The latest completed or failed tasks from the current Aura runtime." />
            <div className="mt-4 flex flex-col gap-3">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.01] py-16 text-center transition-all hover:border-white/[0.12] hover:bg-white/[0.03]">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet shadow-[0_0_24px_rgba(124,58,237,0.2)]">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2v4" />
                      <path d="M12 18v4" />
                      <path d="M4.93 4.93l2.83 2.83" />
                      <path d="M16.24 16.24l2.83 2.83" />
                      <path d="M2 12h4" />
                      <path d="M18 12h4" />
                      <path d="M4.93 19.07l2.83-2.83" />
                      <path d="M16.24 7.76l2.83-2.83" />
                    </svg>
                  </div>
                  <p className="text-[15px] font-semibold text-aura-text">No tasks yet</p>
                  <p className="mt-2 max-w-[320px] text-[13px] leading-relaxed tracking-wide text-aura-muted">
                    Start from the chat workspace above and Aura will begin filling this feed with completed work.
                  </p>
                </div>
              ) : (
                history.slice(0, 5).map((entry) => (
                  <div key={entry.id} className="flex flex-col gap-3 rounded-[24px] border border-white/[0.04] bg-white/[0.02] p-5 transition-all hover:border-white/[0.08] hover:bg-white/[0.04]">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[15px] font-semibold text-aura-text">{entry.command}</p>
                      <StatusPill label={entry.status} tone={entry.status === "done" ? "success" : entry.status === "error" ? "error" : "default"} />
                    </div>
                    <p className="rounded-[14px] border border-white/[0.02] bg-black/20 p-3.5 text-[13px] leading-relaxed text-aura-muted line-clamp-2">
                      {normalizeTextContent(entry.result)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <p className="px-1 text-[15px] font-bold tracking-tight text-aura-text">Quick Actions</p>
          <div className="flex flex-col gap-3">
            <QuickAction
              label="View Managed Runtime"
              detail="Inspect runtime health, gateway state, and managed diagnostics."
              onClick={() => void setRoute("settings")}
            />
            <QuickAction
              label="Open Browser Surface"
              detail="Jump into the embedded browser when you want manual context and AI side-by-side."
              onClick={() => void setRoute("browser")}
            />
            <QuickAction
              label="Review Skills"
              detail="See the normalized OpenClaw skill catalog and jump into a guided prompt."
              onClick={() => void setRoute("skills")}
            />
            <QuickAction
              label="Launch Widget"
              detail="Bring up the floating assistant for faster access while you keep working."
              onClick={() => void window.auraDesktop.app.showWidgetWindow()}
            />
            <QuickAction
              label="Open History"
              detail="Reload prior OpenClaw sessions and continue a conversation from the canonical history."
              onClick={() => void setRoute("history")}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
