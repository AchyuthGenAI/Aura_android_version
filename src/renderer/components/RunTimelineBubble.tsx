import { AuraLogoBlob } from "./primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";

const surfaceLabel: Record<string, string> = {
  chat: "Chat",
  browser: "Browser",
  desktop: "Desktop",
  automation: "Automation",
  mixed: "Mixed",
};

const statusLabel: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  done: "Complete",
  error: "Needs attention",
  cancelled: "Stopped",
};

const describeTool = (value?: string): string => {
  if (!value) return "Preparing tools";
  const [tool, action] = value.split(":");
  return [tool, action].filter(Boolean).join(" ").replace(/_/g, " ");
};

export const RunTimelineBubble = (): JSX.Element | null => {
  const activeRun = useAuraStore((state) => state.activeRun);
  const actionFeed = useAuraStore((state) => state.actionFeed);

  if (!activeRun) {
    return null;
  }

  const runFeed = actionFeed
    .filter((entry) => (
      (activeRun.runId && entry.runId === activeRun.runId)
      || entry.taskId === activeRun.taskId
      || entry.messageId === activeRun.messageId
    ))
    .slice(-4);

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[88%] gap-3">
        <div className="mt-1">
          <AuraLogoBlob size="xs" isTaskRunning={activeRun.status === "running" || activeRun.status === "queued"} />
        </div>
        <div className="min-w-[300px] max-w-[560px] rounded-[24px] rounded-bl-md border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.14),transparent_34%),rgba(255,255,255,0.05)] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-[#f4d47c]">OpenClaw Run</p>
              <p className="mt-1 text-sm font-semibold text-aura-text">{activeRun.prompt}</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-aura-muted">
                {surfaceLabel[activeRun.surface] ?? activeRun.surface}
              </p>
              <p className="mt-1 text-xs text-aura-text">{statusLabel[activeRun.status] ?? activeRun.status}</p>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Tool activity</p>
              <p className="mt-1 text-sm font-semibold text-aura-text">{activeRun.toolCount}</p>
            </div>
            <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Latest tool</p>
              <p className="mt-1 truncate text-sm font-semibold text-aura-text">{describeTool(activeRun.lastTool)}</p>
            </div>
            <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Run id</p>
              <p className="mt-1 truncate text-sm font-semibold text-aura-text">{activeRun.runId ?? activeRun.id}</p>
            </div>
          </div>

          {runFeed.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {runFeed.map((entry, index) => (
                <div
                  key={`${entry.toolUseId ?? index}-${entry.timestamp}`}
                  className="flex items-center justify-between gap-3 rounded-[14px] border border-white/6 bg-white/[0.04] px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-aura-text">
                      {entry.tool.replace(/_/g, " ")} {entry.action.replace(/_/g, " ")}
                    </p>
                    <p className="truncate text-[11px] text-aura-muted">
                      {entry.surface ? `${surfaceLabel[entry.surface] ?? entry.surface} surface` : "Managed tool event"}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-aura-muted">{entry.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
