import type { AppRoute } from "@shared/types";
import { useAuraStore } from "@renderer/store/useAuraStore";

import { StatusPill } from "../primitives";
import { Button } from "../shared";
import { BrowserPage } from "../pages/BrowserPage";
import { DesktopPage } from "../pages/DesktopPage";
import { HistoryPage } from "../pages/HistoryPage";
import { HomePage } from "../pages/HomePage";
import { MonitorsPage } from "../pages/MonitorsPage";
import { ProfilePage } from "../pages/ProfilePage";
import { SettingsPage } from "../pages/SettingsPage";
import { SkillsPage } from "../pages/SkillsPage";
import { AppSidebar } from "./AppSidebar";

const ROUTE_META: Record<AppRoute, { eyebrow: string; title: string; detail: string }> = {
  home: {
    eyebrow: "Conversation",
    title: "Managed OpenClaw Command Center",
    detail: "Run chat, voice, browser, desktop, and automation work from one stateful surface.",
  },
  desktop: {
    eyebrow: "Desktop",
    title: "Native Desktop Control",
    detail: "Keep full desktop automation anchored to the same OpenClaw runtime and session timeline.",
  },
  browser: {
    eyebrow: "Workspace",
    title: "Live Browser Context",
    detail: "Inspect the current page while OpenClaw reads, clicks, extracts, and reports progress back into chat.",
  },
  monitors: {
    eyebrow: "Automations",
    title: "Schedules And Watch Jobs",
    detail: "Create recurring checks, scheduled tasks, and background watch workflows without exposing runtime setup.",
  },
  skills: {
    eyebrow: "Skills",
    title: "Capability Catalog",
    detail: "Browse the bundled OpenClaw skills, understand what each one unlocks, and launch tasks from a curated surface.",
  },
  history: {
    eyebrow: "History",
    title: "Runs And Sessions",
    detail: "Review previous requests, outcomes, and timelines so you can pick work back up quickly.",
  },
  profile: {
    eyebrow: "Profile",
    title: "Automation Memory",
    detail: "Store the details Aura can safely reuse when OpenClaw helps with repeated workflows and autofill-style tasks.",
  },
  settings: {
    eyebrow: "Runtime",
    title: "Managed Runtime Health",
    detail: "Inspect the packaged OpenClaw runtime, permissions, and support diagnostics without editing raw provider settings.",
  },
};

const getRuntimeTone = (phase: ReturnType<typeof useAuraStore.getState>["runtimeStatus"]["phase"]): "success" | "warning" | "error" | "default" => {
  if (phase === "ready") return "success";
  if (phase === "error" || phase === "install-required") return "error";
  if (phase === "running" || phase === "starting" || phase === "checking") return "warning";
  return "default";
};

const MainHeader = (): JSX.Element => {
  const route = useAuraStore((state) => state.route);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const automationJobs = useAuraStore((state) => state.automationJobs);
  const activeRun = useAuraStore((state) => state.activeRun);
  const recentRuns = useAuraStore((state) => state.recentRuns);
  const skills = useAuraStore((state) => state.skills);
  const sessions = useAuraStore((state) => state.sessions);

  const meta = ROUTE_META[route];
  const activeJobs = automationJobs.filter((job) => job.status === "active").length;

  return (
    <div className="relative overflow-hidden rounded-[30px] border border-white/6 bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.15),transparent_30%),radial-gradient(circle_at_top_right,rgba(6,182,212,0.12),transparent_28%),rgba(12,11,20,0.78)] px-6 py-5 shadow-[0_24px_80px_rgba(3,6,20,0.32)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.04),transparent_38%,transparent_62%,rgba(255,255,255,0.02))]" />
      <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <p className="text-[11px] uppercase tracking-[0.28em] text-aura-muted">{meta.eyebrow}</p>
          <h1 className="mt-3 text-[30px] font-bold tracking-tight text-aura-text">{meta.title}</h1>
          <p className="mt-2 max-w-[760px] text-sm leading-7 text-aura-muted">{meta.detail}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 xl:min-w-[460px]">
          <TopMetric label="Runtime" value={runtimeStatus.phase} detail={runtimeStatus.gatewayConnected ? "Gateway connected" : runtimeStatus.message} />
          <TopMetric label="Automations" value={String(activeJobs)} detail={`${automationJobs.length} saved jobs`} />
          <TopMetric label="Runs" value={String(recentRuns.length)} detail={activeRun ? `${activeRun.surface} run live` : `${sessions.length} sessions · ${skills.length} skills`} />
        </div>
      </div>

      <div className="relative mt-5 flex flex-wrap items-center gap-3">
        <StatusPill label={runtimeStatus.phase} tone={getRuntimeTone(runtimeStatus.phase)} />
        <span className="text-xs text-aura-muted">{runtimeStatus.message}</span>
        <div className="ml-auto flex flex-wrap gap-3">
          <Button
            className="border border-white/10 bg-white/6 text-aura-text hover:bg-white/12"
            onClick={() => void window.auraDesktop.app.showWidgetWindow()}
          >
            Open Widget
          </Button>
          <Button className="bg-aura-gradient text-white shadow-aura-glow" onClick={() => void useAuraStore.getState().setRoute("home")}>
            Return To Chat
          </Button>
        </div>
      </div>
    </div>
  );
};

const TopMetric = ({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element => (
  <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
    <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">{label}</p>
    <p className="mt-2 text-[24px] font-bold tracking-tight text-aura-text capitalize">{value}</p>
    <p className="mt-1 text-xs leading-5 text-aura-muted">{detail}</p>
  </div>
);

const SurfaceBody = (): JSX.Element => {
  const route = useAuraStore((state) => state.route);

  if (route === "home") return <HomePage />;
  if (route === "desktop") return <DesktopPage />;
  if (route === "browser") return <BrowserPage />;
  if (route === "monitors") return <MonitorsPage />;
  if (route === "skills") return <SkillsPage />;
  if (route === "history") return <HistoryPage />;
  if (route === "profile") return <ProfilePage />;
  return <SettingsPage />;
};

export const MainSurface = (): JSX.Element => {
  return (
    <div className="mx-auto flex h-full w-full max-w-[1920px] flex-row overflow-hidden bg-[#0c0b14]">
      <AppSidebar />
      <div className="relative min-w-0 flex-1 overflow-hidden px-8 py-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.10),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(6,182,212,0.10),transparent_24%)] mix-blend-screen" />
        <div className="relative flex h-full flex-col gap-5">
          <MainHeader />
          <div className="min-h-0 flex-1 overflow-hidden rounded-[34px] border border-white/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))] px-6 py-6 shadow-[0_30px_90px_rgba(3,6,20,0.26)]">
            <SurfaceBody />
          </div>
        </div>
      </div>
    </div>
  );
};
