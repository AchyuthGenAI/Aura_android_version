import { useAuraStore } from "@renderer/store/useAuraStore";
import { normalizeTextContent } from "@shared/text-content";

import { StatusPill } from "../primitives";
import { SectionHeading } from "../shared";

/* ── Inline metric tile with optional click + live-dot ────────────────── */
const MetricTile = ({
  label,
  value,
  detail,
  alive,
  onClick,
}: {
  label: string;
  value: string | number;
  detail: string;
  alive?: boolean;
  onClick?: () => void;
}): JSX.Element => (
  <div
    className={`group relative overflow-hidden rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent px-5 py-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-white/[0.12] hover:shadow-[0_8px_30px_rgba(124,58,237,0.08)] ${onClick ? "cursor-pointer" : ""}`}
    onClick={onClick}
  >
    {/* Top highlight line on hover */}
    <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-aura-violet/30 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
    <div className="flex items-center justify-between">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-aura-muted transition-colors group-hover:text-aura-text">
        {label}
      </p>
      {alive !== undefined && (
        <div
          className={`h-2 w-2 rounded-full transition-shadow ${
            alive
              ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]"
              : "bg-white/20"
          }`}
        />
      )}
    </div>
    <p className="mt-4 text-[32px] font-bold tracking-tight text-aura-text transition-transform duration-200 group-hover:translate-x-0.5">
      {value}
    </p>
    <p className="mt-1 pb-1 text-[13px] text-aura-muted/80">{detail}</p>
  </div>
);

/* ── Quick Action button ──────────────────────────────────────────────── */
const QuickAction = ({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: JSX.Element;
  onClick: () => void;
}): JSX.Element => (
  <button
    className="group flex w-full items-center gap-4 rounded-[20px] border border-white/[0.05] bg-gradient-to-r from-white/[0.02] to-transparent px-5 py-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-aura-violet/20 hover:bg-white/[0.04] hover:shadow-[0_4px_20px_rgba(124,58,237,0.06)]"
    onClick={onClick}
  >
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border border-white/[0.06] bg-white/[0.04] text-aura-muted transition-colors group-hover:border-aura-violet/30 group-hover:bg-aura-violet/10 group-hover:text-aura-violet">
      {icon}
    </div>
    <span className="flex-1 text-[14px] font-semibold text-aura-text transition-colors group-hover:text-white">
      {label}
    </span>
    <svg
      className="h-4 w-4 text-aura-muted/50 transition-all group-hover:translate-x-0.5 group-hover:text-aura-violet"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  </button>
);

export const HomePage = (): JSX.Element => {
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const activeMonitorsCount = useAuraStore((state) =>
    state.monitors.filter((m) => m.status === "active").length,
  );
  const activeTabsCount = useAuraStore((state) => state.browserTabs.length);
  const history = useAuraStore((state) => state.history);
  const profile = useAuraStore((state) => state.profile);
  const setRoute = useAuraStore((state) => state.setRoute);
  const activeBrowserTabId = useAuraStore((state) => state.activeBrowserTabId);

  const firstName = profile.fullName ? profile.fullName.split(" ")[0] : "User";
  const engineOnline = runtimeStatus.phase === "ready";
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="mx-auto flex h-full w-full max-w-[1200px] flex-col gap-8 overflow-y-auto pr-2 pb-8">
      {/* ── Hero banner ──────────────────────────────────────────────── */}
      <div className="relative mt-4 overflow-hidden rounded-[28px] border border-white/[0.06] bg-gradient-to-br from-aura-violet/[0.08] via-transparent to-aura-cyan/[0.04] px-8 py-8">
        <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-aura-violet/10 blur-3xl" />
        <div className="absolute -bottom-10 -left-10 h-32 w-32 rounded-full bg-aura-cyan/8 blur-2xl" />
        <div className="relative">
          <p className="text-[13px] font-semibold uppercase tracking-[0.2em] text-aura-violet">
            {greeting}
          </p>
          <h1 className="mt-2 text-[32px] font-bold tracking-tight text-white">
            Welcome back, {firstName}
          </h1>
          <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-aura-muted">
            Here's a quick overview of your Aura system. Everything you need to
            monitor, automate, and control — in one place.
          </p>
        </div>
      </div>

      <div className="grid gap-8 xl:grid-cols-[1fr_340px]">
        {/* ── Left column ────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-8">
          {/* System Health */}
          <div className="flex flex-col">
            <SectionHeading
              title="System Health"
              detail="Status of your local OpenClaw engine and connectivity."
            />
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <MetricTile
                label="Aura Engine"
                value={engineOnline ? "Online" : runtimeStatus.phase}
                detail={runtimeStatus.message}
                alive={engineOnline}
              />
              <MetricTile
                label="Built-in Browser"
                value={activeTabsCount}
                detail="Active tabs"
                alive={Boolean(activeBrowserTabId)}
                onClick={() => void setRoute("browser")}
              />
              <MetricTile
                label="Active Monitors"
                value={activeMonitorsCount}
                detail="Running background checks"
                alive={activeMonitorsCount > 0}
                onClick={() => void setRoute("monitors")}
              />
              <MetricTile
                label="Network Latency"
                value="24ms"
                detail="Gateway response time"
              />
            </div>
          </div>

          {/* Recent History */}
          <div className="flex flex-col">
            <SectionHeading
              title="Recent Task History"
              detail="The latest tasks completed by Aura."
            />
            <div className="mt-4 flex flex-col gap-3">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/[0.08] bg-white/[0.01] py-16 text-center transition-all hover:border-white/[0.12] hover:bg-white/[0.03]">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet shadow-[0_0_24px_rgba(124,58,237,0.15)]">
                    <svg
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                  <p className="text-[15px] font-semibold text-aura-text">
                    No Tasks Yet
                  </p>
                  <p className="mt-2 max-w-[260px] text-[13px] leading-relaxed text-aura-muted">
                    Use the widget to ask Aura to perform a task across your
                    system.
                  </p>
                </div>
              ) : (
                history.slice(0, 5).map((entry) => (
                  <div
                    key={entry.id}
                    className="group relative overflow-hidden rounded-[22px] border border-white/[0.05] bg-gradient-to-b from-white/[0.02] to-transparent p-5 transition-all duration-200 hover:border-white/[0.1] hover:shadow-[0_4px_16px_rgba(124,58,237,0.06)]"
                  >
                    <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-[15px] font-semibold text-aura-text transition-colors group-hover:text-white">
                        {entry.command}
                      </p>
                      <StatusPill
                        label={entry.status}
                        tone={
                          entry.status === "done"
                            ? "success"
                            : entry.status === "error"
                              ? "error"
                              : "default"
                        }
                      />
                    </div>
                    <p className="mt-3 line-clamp-2 rounded-[14px] border border-white/[0.03] bg-black/20 p-3.5 text-[13px] leading-relaxed text-aura-muted">
                      {normalizeTextContent(entry.result)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* ── Right sidebar ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-6">
          <p className="text-[13px] font-bold uppercase tracking-[0.15em] text-aura-muted">
            Quick Actions
          </p>
          <div className="flex flex-col gap-2">
            <QuickAction
              label="View Managed Runtime"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              }
              onClick={() => void setRoute("settings")}
            />
            <QuickAction
              label="Launch Widget"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
              }
              onClick={() => void window.auraDesktop.app.showWidgetWindow()}
            />
            <QuickAction
              label="Browse Skills"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              }
              onClick={() => void setRoute("skills")}
            />
            <QuickAction
              label="View History"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              }
              onClick={() => void setRoute("history")}
            />
            <QuickAction
              label="Monitors & Scheduler"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              }
              onClick={() => void setRoute("monitors")}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
