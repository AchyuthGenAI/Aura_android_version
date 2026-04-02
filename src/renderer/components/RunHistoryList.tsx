import type { OpenClawRun } from "@shared/types";

const formatTime = (ts: number): string => {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
};

const statusTone: Record<OpenClawRun["status"], string> = {
  queued: "text-amber-300",
  running: "text-aura-violet",
  done: "text-emerald-300",
  error: "text-rose-300",
  cancelled: "text-aura-muted",
};

export const RunHistoryList = ({
  runs,
  selectedRunId,
  onSelect,
  compact = false,
  emptyMessage = "No OpenClaw runs yet.",
}: {
  runs: OpenClawRun[];
  selectedRunId?: string | null;
  onSelect?: (run: OpenClawRun) => void;
  compact?: boolean;
  emptyMessage?: string;
}): JSX.Element => {
  if (runs.length === 0) {
    return (
      <div className="rounded-[22px] border border-dashed border-white/10 bg-white/[0.03] px-4 py-5 text-sm text-aura-muted">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${compact ? "gap-2" : "gap-3"}`}>
      {runs.map((run) => {
        const selected = selectedRunId === run.id;
        return (
          <button
            key={run.id}
            onClick={() => onSelect?.(run)}
            className={`w-full rounded-[20px] border px-4 py-3 text-left transition ${
              selected
                ? "border-aura-violet/30 bg-aura-violet/10"
                : "border-white/6 bg-white/[0.03] hover:bg-white/[0.05]"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-aura-text">{run.prompt}</p>
                <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-aura-muted">
                  {run.surface} surface
                </p>
              </div>
              <div className="text-right">
                <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${statusTone[run.status]}`}>
                  {run.status}
                </p>
                <p className="mt-1 text-[10px] text-aura-muted">{formatTime(run.updatedAt)}</p>
              </div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Tools</p>
                <p className="mt-1 text-xs font-semibold text-aura-text">{run.toolCount}</p>
              </div>
              <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Latest</p>
                <p className="mt-1 truncate text-xs font-semibold text-aura-text">
                  {run.lastTool?.replace(":", " ").replace(/_/g, " ") ?? "No tools yet"}
                </p>
              </div>
              <div className="rounded-[14px] border border-white/6 bg-black/20 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">Run</p>
                <p className="mt-1 truncate text-xs font-semibold text-aura-text">{run.runId ?? run.id}</p>
              </div>
            </div>
            {(run.summary || run.error) && !compact && (
              <p className="mt-3 line-clamp-2 text-xs leading-5 text-aura-muted">
                {run.summary ?? run.error}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
};
