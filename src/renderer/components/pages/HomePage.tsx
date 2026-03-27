import { useAuraStore } from "@renderer/store/useAuraStore";

import { AuraLogoBlob, StatusPill } from "../primitives";
import { Card, InfoTile, SectionHeading } from "../shared";

export const HomePage = (): JSX.Element => {
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const activeMonitorsCount = useAuraStore((state) => state.monitors.filter((m) => m.status === "active").length);
  const activeTabsCount = useAuraStore((state) => state.browserTabs.length);
  const history = useAuraStore((state) => state.history);
  const profile = useAuraStore((state) => state.profile);
  const setRoute = useAuraStore((state) => state.setRoute);
  const activeBrowserTabId = useAuraStore((state) => state.activeBrowserTabId);

  const firstName = profile.fullName ? profile.fullName.split(" ")[0] : "User";

  return (
    <div className="mx-auto flex h-full w-full max-w-[1200px] flex-col gap-8 overflow-y-auto pr-2 pb-8">
      <div className="flex flex-col mt-4">
        <h1 className="text-[32px] font-bold tracking-tight text-white mb-1">
          Welcome back, {firstName}
        </h1>
        <p className="text-[15px] text-aura-muted">Here's a quick overview of your system.</p>
      </div>

      <div className="grid gap-8 xl:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col">
            <SectionHeading title="System Health" detail="Status of your local OpenClaw engine and connectivity." />
            <div className="mt-4 grid gap-4 md:grid-cols-2">
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
              <p className="mt-1 pb-1 text-[13px] text-aura-muted opacity-80">Active Tabs</p>
            </div>
            <div 
              className="group cursor-pointer rounded-[24px] border border-white/[0.06] bg-white/[0.02] px-5 py-5 transition-all hover:border-white/[0.1] hover:bg-white/[0.04]"
              onClick={() => void setRoute("monitors")}
            >
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted transition-colors group-hover:text-aura-text">Active Monitors</p>
                <div className={`h-2 w-2 rounded-full ${activeMonitorsCount > 0 ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]" : "bg-white/20"}`} />
              </div>
              <p className="mt-4 text-[32px] font-bold tracking-tight text-aura-text transition-transform group-hover:translate-x-1">{activeMonitorsCount}</p>
              <p className="mt-1 pb-1 text-[13px] text-aura-muted opacity-80">Running background checks</p>
            </div>
            <div 
              className="group cursor-pointer rounded-[24px] border border-white/[0.06] bg-white/[0.02] px-5 py-5 transition-all hover:border-white/[0.1] hover:bg-white/[0.04]"
            >
              <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted transition-colors group-hover:text-aura-text">Network Latency</p>
              <p className="mt-4 text-[32px] font-bold tracking-tight text-aura-text transition-transform group-hover:translate-x-1">24ms</p>
              <p className="mt-1 pb-1 text-[13px] text-aura-muted opacity-80">Gateway response time</p>
            </div>
          </div>
          </div>
          <div className="flex flex-col mt-4">
            <SectionHeading title="Recent Task History" detail="The latest tasks completed by Aura." />
            <div className="mt-4 flex flex-col gap-3">
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.01] py-16 text-center transition-all hover:border-white/[0.12] hover:bg-white/[0.03]">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet shadow-[0_0_24px_rgba(124,58,237,0.2)]">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>
                </div>
                <p className="text-[15px] font-semibold text-aura-text">No Tasks Yet</p>
                <p className="mt-2 text-[13px] text-aura-muted max-w-[260px] leading-relaxed tracking-wide">Use the widget to ask Aura to perform a task across your system.</p>
              </div>
            ) : (
              history.slice(0, 5).map((entry) => (
                <div key={entry.id} className="flex flex-col gap-3 rounded-[24px] border border-white/[0.04] bg-white/[0.02] p-5 hover:border-white/[0.08] hover:bg-white/[0.04] transition-all">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-aura-text text-[15px]">{entry.command}</p>
                    <StatusPill label={entry.status} tone={entry.status === "done" ? "success" : entry.status === "error" ? "error" : "default"} />
                  </div>
                  <p className="text-[13px] leading-relaxed text-aura-muted line-clamp-2 bg-black/20 rounded-[14px] p-3.5 border border-white/[0.02]">{entry.result}</p>
                </div>
              ))
            )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <p className="text-[15px] font-bold tracking-tight text-aura-text px-1">Quick Actions</p>
          <div className="flex flex-col gap-2">
            <button 
              className="group flex items-center justify-between rounded-[20px] bg-white/[0.02] border border-white/5 px-5 py-4 transition-all hover:bg-white/[0.04] hover:border-white/10 hover:-translate-y-0.5"
              onClick={() => void setRoute("settings")}
            >
              <span className="text-[14px] font-semibold text-aura-text group-hover:text-white">Manage AI Models</span>
              <span className="text-aura-muted transition-transform group-hover:translate-x-1">→</span>
            </button>
            <button className="group flex items-center justify-between rounded-[20px] bg-white/[0.02] border border-white/5 px-5 py-4 transition-all hover:bg-white/[0.04] hover:border-white/10 hover:-translate-y-0.5" onClick={() => void window.auraDesktop.app.showWidgetWindow()}>
              <span className="text-[14px] font-semibold text-aura-text group-hover:text-white">Launch Widget</span>
              <span className="text-aura-muted transition-transform group-hover:translate-x-1">→</span>
            </button>
            <button 
              className="group flex items-center justify-between rounded-[20px] bg-white/[0.02] border border-white/5 px-5 py-4 transition-all hover:bg-white/[0.04] hover:border-white/10 hover:-translate-y-0.5"
              onClick={() => void setRoute("skills")}
            >
              <span className="text-aura-muted">→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
