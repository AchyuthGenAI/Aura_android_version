import { useAuraStore } from "@renderer/store/useAuraStore";

import { ChatComposer, ChatThread, TaskBanner } from "../ChatThread";
import { AuraLogoBlob, StatusPill } from "../primitives";
import { Button, Card, InfoTile, SectionHeading } from "../shared";
import { SessionSidebar } from "../SessionSidebar";

export const HomePage = (): JSX.Element => {
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const history = useAuraStore((state) => state.history);
  const pageContext = useAuraStore((state) => state.pageContext);
  const setRoute = useAuraStore((state) => state.setRoute);

  return (
    <div className="grid h-full min-h-0 gap-5 overflow-y-auto pr-1 xl:grid-cols-[300px_minmax(0,1.45fr)_340px]">
      <div className="min-h-0">
        <SessionSidebar />
      </div>
      <div className="flex min-h-0 flex-col gap-4">
        <Card className="px-7 py-7">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.18),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(6,182,212,0.12),transparent_28%)]" />
          <div className="relative flex flex-col gap-7">
            <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-[680px]">
                <p className="text-xs uppercase tracking-[0.3em] text-aura-violet">Aura Desktop</p>
                <h1 className="mt-3 max-w-[760px] text-[42px] font-semibold leading-[1.1] tracking-tight text-aura-text">
                  A calmer desktop workspace for browser tasks, local AI, and always-on-top Aura help.
                </h1>
                <p className="mt-4 max-w-[620px] text-sm leading-7 text-aura-muted">
                  The widget handles fast, always-available conversations. This desktop app is where you manage browser work,
                  review history, run monitors, and shape the rest of your Aura environment.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <button
                  className="rounded-[24px] border border-white/10 bg-white/8 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:bg-white/12"
                  onClick={() => void window.auraDesktop.app.showWidgetWindow()}
                >
                  <p className="text-sm font-semibold text-aura-text">Open Aura</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">Bring the widget forward above your desktop.</p>
                </button>
                <button
                  className="rounded-[24px] border border-white/10 bg-white/8 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:bg-white/12"
                  onClick={() => void setRoute("browser")}
                >
                  <p className="text-sm font-semibold text-aura-text">Open Browser</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">Work inside the built-in browser with page context.</p>
                </button>
                <button
                  className="rounded-[24px] border border-white/10 bg-white/8 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:bg-white/12"
                  onClick={() => void setRoute("settings")}
                >
                  <p className="text-sm font-semibold text-aura-text">Review Setup</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">Tune startup, provider, permissions, and theme.</p>
                </button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <InfoTile
                label="Runtime"
                value={runtimeStatus.phase === "ready" ? "Ready" : runtimeStatus.phase}
                detail={runtimeStatus.message}
              />
              <InfoTile
                label="Widget"
                value="Always On"
                detail="Aura stays one click away without layering over this window."
              />
              <InfoTile
                label="Browser"
                value={pageContext?.title ? "Connected" : "Waiting"}
                detail={pageContext?.url || "Open the Browser route to pull live page context."}
              />
            </div>
          </div>
        </Card>
        <TaskBanner />
        <Card className="flex min-h-0 flex-1 flex-col px-6 py-6">
          <div className="mb-5 flex items-center justify-between gap-4">
            <SectionHeading title="Workspace" detail="Your primary chat canvas for desktop tasks and multi-step work." />
            <StatusPill
              label={runtimeStatus.message}
              tone={runtimeStatus.phase === "ready" ? "success" : runtimeStatus.phase === "error" ? "error" : "default"}
            />
          </div>
          <div className="min-h-0 flex-1">
            <ChatThread emptyContext="home" />
          </div>
          <div className="mt-4">
            <ChatComposer />
          </div>
        </Card>
      </div>
      <div className="flex min-h-0 flex-col gap-4">
        <Card className="px-5 py-5">
          <SectionHeading title="Recent Activity" detail="Task outcomes and errors from your latest local runs." />
          <div className="mt-4 space-y-2">
            {history.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-white/10 bg-white/4 px-4 py-5 text-sm text-aura-muted">
                Run a task and Aura will keep a digest of the results here.
              </div>
            ) : (
              history.slice(0, 5).map((entry) => (
                <div key={entry.id} className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
                  <p className="text-sm font-semibold text-aura-text">{entry.command}</p>
                  <p className="mt-2 text-xs leading-6 text-aura-muted line-clamp-3">{entry.result}</p>
                </div>
              ))
            )}
          </div>
        </Card>
        <Card className="px-5 py-5">
          <SectionHeading title="Current Page" detail="The latest context available from the built-in browser." />
          {pageContext ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-semibold text-aura-text">{pageContext.title}</p>
              <p className="text-xs text-aura-muted">{pageContext.url}</p>
              <p className="rounded-[22px] border border-white/8 bg-white/5 p-4 text-xs leading-6 text-aura-muted">
                {pageContext.visibleText.slice(0, 420) || "No page text captured yet."}
              </p>
            </div>
          ) : (
            <p className="mt-4 text-sm text-aura-muted">Open the Browser route to populate live page context.</p>
          )}
        </Card>
      </div>
    </div>
  );
};
