import { useAuraStore } from "@renderer/store/useAuraStore";

import { AuraLogoBlob, StatusPill } from "../primitives";
import { Card, InfoTile, SectionHeading } from "../shared";

export const HomePage = (): JSX.Element => {
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const history = useAuraStore((state) => state.history);
  const monitors = useAuraStore((state) => state.monitors);
  const setRoute = useAuraStore((state) => state.setRoute);
  const browserTabs = useAuraStore((state) => state.browserTabs);
  const activeBrowserTabId = useAuraStore((state) => state.activeBrowserTabId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto pr-2 pb-6">

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <SectionHeading title="System Health" detail="Status of your local OpenClaw engine and connectivity." />
          <div className="grid gap-4 sm:grid-cols-2">
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
              <p className="mt-4 text-[32px] font-bold tracking-tight text-aura-text transition-transform group-hover:translate-x-1">{browserTabs.length}</p>
              <p className="mt-1 pb-1 text-[13px] text-aura-muted opacity-80">Active Tabs</p>
            </div>
            <div 
              className="group cursor-pointer rounded-[24px] border border-white/[0.06] bg-white/[0.02] px-5 py-5 transition-all hover:border-white/[0.1] hover:bg-white/[0.04]"
              onClick={() => void setRoute("monitors")}
            >
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted transition-colors group-hover:text-aura-text">Active Monitors</p>
                <div className={`h-2 w-2 rounded-full ${monitors.length > 0 ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]" : "bg-white/20"}`} />
              </div>
              <p className="mt-4 text-[32px] font-bold tracking-tight text-aura-text transition-transform group-hover:translate-x-1">{monitors.filter(m => m.status === "active").length}</p>
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

          <SectionHeading title="Recent Task History" detail="The latest tasks completed by Aura." />
          <div className="flex flex-col gap-3">
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.02] py-16 text-center">
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

        <div className="flex flex-col gap-6">
          <Card className="flex flex-col gap-2">
            <h3 className="mb-2 text-[16px] font-bold tracking-tight text-aura-text">Quick Actions</h3>
            <button 
              className="flex items-center justify-between rounded-[20px] bg-white/[0.02] px-5 py-4 text-[14px] font-medium text-aura-text transition-all hover:bg-white/[0.06] hover:-translate-y-0.5 border border-transparent hover:border-white/[0.05]"
              onClick={() => void setRoute("settings")}
            >
              <span>Manage AI Models</span>
              <span className="text-aura-muted">→</span>
            </button>
            <button 
              className="flex items-center justify-between rounded-[20px] bg-white/[0.02] px-5 py-4 text-[14px] font-medium text-aura-text transition-all hover:bg-white/[0.06] hover:-translate-y-0.5 border border-transparent hover:border-white/[0.05]"
              onClick={() => void setRoute("profile")}
            >
              <span>Update Profile</span>
              <span className="text-aura-muted">→</span>
            </button>
            <button 
              className="flex items-center justify-between rounded-[20px] bg-white/[0.02] px-5 py-4 text-[14px] font-medium text-aura-text transition-all hover:bg-white/[0.06] hover:-translate-y-0.5 border border-transparent hover:border-white/[0.05]"
              onClick={() => void setRoute("skills")}
            >
              <span>Explore Skills</span>
              <span className="text-aura-muted">→</span>
            </button>
          </Card>
        </div>
      </div>
    </div>
  );
};
