import { useState } from "react";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type { AuraSession, HistoryEntry, OpenClawRun } from "@shared/types";

type HistoryFilter = "all" | "chat" | "voice" | "tasks";

const formatTimeAgo = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
};

const formatTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/* ─── Unified entry for the combined timeline ─────────────────────── */
interface TimelineEntry {
  id: string;
  kind: "chat" | "voice" | "task";
  title: string;
  subtitle: string;
  status?: "done" | "error" | "cancelled" | "running";
  timestamp: number;
}

/* ─── Build a flat timeline from all data sources ─────────────────── */
const buildTimeline = (
  sessions: AuraSession[],
  historyEntries: HistoryEntry[],
  recentRuns: OpenClawRun[],
): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];

  // Chat sessions
  for (const session of sessions) {
    const userMsgs = session.messages.filter((m) => m.role === "user");
    const firstUser = userMsgs[0]?.content ?? "New conversation";
    const source = session.messages.find((m) => m.source)?.source;
    entries.push({
      id: `session-${session.id}`,
      kind: source === "voice" ? "voice" : "chat",
      title: session.title ?? firstUser.slice(0, 80),
      subtitle: `${session.messages.length} message${session.messages.length === 1 ? "" : "s"}`,
      status: "done",
      timestamp: session.endedAt ?? session.startedAt,
    });
  }

  // Task / command history
  for (const entry of historyEntries) {
    entries.push({
      id: `history-${entry.id}`,
      kind: "task",
      title: entry.command.slice(0, 80),
      subtitle: entry.result.slice(0, 60) || "Completed",
      status: entry.status,
      timestamp: entry.createdAt,
    });
  }

  // Recent OpenClaw runs
  for (const run of recentRuns) {
    entries.push({
      id: `run-${run.id}`,
      kind: "task",
      title: run.prompt.slice(0, 80),
      subtitle: run.summary ?? `${run.toolCount} tool${run.toolCount === 1 ? "" : "s"} used`,
      status: run.status === "queued" ? "running" : run.status,
      timestamp: run.completedAt ?? run.updatedAt,
    });
  }

  // De-duplicate by id and sort newest first
  const seen = new Set<string>();
  return entries
    .filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    })
    .sort((a, b) => b.timestamp - a.timestamp);
};

/* ─── Icons ───────────────────────────────────────────────────────── */
const ChatIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const VoiceIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

const TaskIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 11 12 14 22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);

const KindIcon = ({ kind }: { kind: "chat" | "voice" | "task" }) => {
  if (kind === "voice") return <VoiceIcon />;
  if (kind === "task") return <TaskIcon />;
  return <ChatIcon />;
};

/* ─── Status badge colors ─────────────────────────────────────────── */
const statusColor = (status?: string) => {
  switch (status) {
    case "done":
      return "text-emerald-400";
    case "error":
      return "text-red-400";
    case "cancelled":
      return "text-amber-400";
    case "running":
      return "text-violet-400";
    default:
      return "text-aura-muted";
  }
};

const statusDot = (status?: string) => {
  switch (status) {
    case "done":
      return "bg-emerald-400";
    case "error":
      return "bg-red-400";
    case "cancelled":
      return "bg-amber-400";
    case "running":
      return "bg-violet-400 animate-pulse";
    default:
      return "bg-white/20";
  }
};

/* ─── Filter pills ────────────────────────────────────────────────── */
const FILTERS: { id: HistoryFilter; label: string; icon: JSX.Element }[] = [
  { id: "all", label: "All", icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /></svg> },
  { id: "chat", label: "Chat", icon: <ChatIcon /> },
  { id: "voice", label: "Voice", icon: <VoiceIcon /> },
  { id: "tasks", label: "Tasks", icon: <TaskIcon /> },
];

/* ─── Main Component ──────────────────────────────────────────────── */
export const HistoryPanel = (): JSX.Element => {
  const sessions = useAuraStore((s) => s.sessions);
  const history = useAuraStore((s) => s.history);
  const recentRuns = useAuraStore((s) => s.recentRuns);
  const loadSession = useAuraStore((s) => s.loadSession);
  const [filter, setFilter] = useState<HistoryFilter>("all");

  const timeline = buildTimeline(sessions, history, recentRuns);

  const filtered = filter === "all"
    ? timeline
    : filter === "tasks"
      ? timeline.filter((e) => e.kind === "task")
      : timeline.filter((e) => e.kind === filter);

  // Group entries by date
  const groups = new Map<string, TimelineEntry[]>();
  for (const entry of filtered) {
    const d = new Date(entry.timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    let label: string;
    if (d.toDateString() === today.toDateString()) {
      label = "Today";
    } else if (d.toDateString() === yesterday.toDateString()) {
      label = "Yesterday";
    } else {
      label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Filter pills */}
      <div className="flex gap-1.5 mb-3 px-0.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-wide transition-all ${
              filter === f.id
                ? "bg-[#35235d] text-[#bca5ff] shadow-inner border border-[#bca5ff]/20"
                : "bg-white/5 text-aura-muted hover:bg-white/10 hover:text-aura-text border border-transparent"
            }`}
          >
            {f.icon}
            {f.label}
          </button>
        ))}
      </div>

      {/* Timeline content */}
      <div className="custom-scroll flex-1 min-h-0 overflow-y-auto pr-1 space-y-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-aura-muted">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-aura-muted">No history yet</p>
              <p className="text-xs text-white/30 mt-1">
                {filter === "all"
                  ? "Start a chat, use voice, or run a task"
                  : filter === "chat"
                    ? "Start a conversation to see it here"
                    : filter === "voice"
                      ? "Use voice mode to see transcripts"
                      : "Run automations to see task history"}
              </p>
            </div>
          </div>
        ) : (
          Array.from(groups.entries()).map(([dateLabel, entries]) => (
            <div key={dateLabel}>
              {/* Date group header */}
              <div className="sticky top-0 z-10 flex items-center gap-2 py-2 backdrop-blur-md">
                <span className="text-[10px] font-bold uppercase tracking-widest text-aura-muted/60">
                  {dateLabel}
                </span>
                <div className="flex-1 h-px bg-white/5" />
                <span className="text-[10px] text-aura-muted/40">{entries.length}</span>
              </div>

              {/* Entries */}
              <div className="space-y-1">
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    className="group flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition-all hover:bg-white/[0.04] active:bg-white/[0.08]"
                    onClick={() => {
                      if (entry.id.startsWith("session-")) {
                        const sessionId = entry.id.replace("session-", "");
                        void loadSession(sessionId);
                      }
                    }}
                  >
                    {/* Icon */}
                    <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                      entry.kind === "chat"
                        ? "bg-violet-500/10 text-violet-400"
                        : entry.kind === "voice"
                          ? "bg-sky-500/10 text-sky-400"
                          : "bg-emerald-500/10 text-emerald-400"
                    }`}>
                      <KindIcon kind={entry.kind} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="truncate text-[13px] font-medium text-aura-text leading-tight">
                          {entry.title}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[11px] text-aura-muted leading-tight">
                          {entry.subtitle}
                        </p>
                      </div>
                    </div>

                    {/* Time + status */}
                    <div className="flex flex-col items-end gap-1 shrink-0 pt-0.5">
                      <span className="text-[10px] text-aura-muted/60 tabular-nums">
                        {formatTime(entry.timestamp)}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className={`h-1.5 w-1.5 rounded-full ${statusDot(entry.status)}`} />
                        <span className={`text-[9px] font-semibold uppercase tracking-wider ${statusColor(entry.status)}`}>
                          {entry.status}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
