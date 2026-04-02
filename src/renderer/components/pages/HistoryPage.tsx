import { useEffect, useMemo, useState } from "react";

import type { AuraSession, OpenClawRun } from "@shared/types";
import { useAuraStore } from "@renderer/store/useAuraStore";

import { RunHistoryList } from "../RunHistoryList";
import { RunTimelineBubble } from "../RunTimelineBubble";
import { SectionHeading } from "../shared";

const formatDate = (ts: number): string => {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isYesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
};

export const HistoryPage = (): JSX.Element => {
  const sessions = useAuraStore((state) => state.sessions);
  const recentRuns = useAuraStore((state) => state.recentRuns);
  const recentRunEvents = useAuraStore((state) => state.recentRunEvents);
  const loadSession = useAuraStore((state) => state.loadSession);
  const [mode, setMode] = useState<"runs" | "sessions">(recentRuns.length > 0 ? "runs" : "sessions");
  const [selectedRun, setSelectedRun] = useState<OpenClawRun | null>(recentRuns[0] ?? null);
  const [selectedSession, setSelectedSession] = useState<AuraSession | null>(sessions[0] ?? null);

  useEffect(() => {
    if (recentRuns.length > 0 && !selectedRun) {
      setSelectedRun(recentRuns[0]);
    }
    if (recentRuns.length === 0 && mode === "runs") {
      setMode("sessions");
    }
  }, [mode, recentRuns, selectedRun]);

  useEffect(() => {
    if (sessions.length > 0 && !selectedSession) {
      setSelectedSession(sessions[0]);
    }
  }, [selectedSession, sessions]);

  const selectedRunSession = useMemo(
    () => sessions.find((session) => session.id === selectedRun?.sessionId) ?? null,
    [selectedRun, sessions],
  );
  const selectedRunEvents = useMemo(() => {
    if (!selectedRun) return [];
    return recentRunEvents[selectedRun.runId ?? selectedRun.id] ?? recentRunEvents[selectedRun.taskId] ?? recentRunEvents[selectedRun.messageId] ?? [];
  }, [recentRunEvents, selectedRun]);

  if (recentRuns.length === 0 && sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm font-medium text-aura-text">No history yet</p>
        <p className="text-xs text-aura-muted">Your OpenClaw runs and conversation sessions will appear here after you start using Aura.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-5 overflow-hidden">
      <div className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto">
        <SectionHeading
          title="History"
          detail={`${recentRuns.length} runs · ${sessions.length} sessions`}
        />

        <div className="grid grid-cols-2 gap-2 rounded-[24px] border border-white/6 bg-black/20 p-1">
          <button
            onClick={() => setMode("runs")}
            className={`rounded-[18px] px-4 py-2 text-sm font-semibold transition ${mode === "runs" ? "bg-aura-violet/15 text-aura-text" : "text-aura-muted hover:bg-white/6 hover:text-aura-text"}`}
          >
            Runs
          </button>
          <button
            onClick={() => setMode("sessions")}
            className={`rounded-[18px] px-4 py-2 text-sm font-semibold transition ${mode === "sessions" ? "bg-aura-violet/15 text-aura-text" : "text-aura-muted hover:bg-white/6 hover:text-aura-text"}`}
          >
            Sessions
          </button>
        </div>

        {mode === "runs" ? (
          <RunHistoryList
            runs={recentRuns}
            selectedRunId={selectedRun?.id ?? null}
            onSelect={setSelectedRun}
            emptyMessage="No completed OpenClaw runs yet."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => setSelectedSession(session)}
                className={`w-full rounded-[20px] border px-4 py-3 text-left transition ${
                  selectedSession?.id === session.id
                    ? "border-aura-violet/30 bg-aura-violet/10 text-aura-text"
                    : "border-white/6 bg-white/[0.03] text-aura-muted hover:bg-white/[0.05] hover:text-aura-text"
                }`}
              >
                <p className="truncate text-sm font-semibold text-aura-text">
                  {session.title ?? session.messages[0]?.content?.slice(0, 50) ?? "Session"}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-aura-muted/70">
                  <span>{formatDate(session.startedAt)}</span>
                  <span>·</span>
                  <span>{session.messages.length} msg{session.messages.length !== 1 ? "s" : ""}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-white/6 bg-white/[0.02]">
        {mode === "runs" ? (
          selectedRun ? (
            <>
              <div className="flex items-center justify-between border-b border-white/6 px-6 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-aura-text">{selectedRun.prompt}</p>
                  <p className="mt-0.5 text-xs text-aura-muted">
                    {selectedRun.surface} surface · {selectedRun.status} · {formatDate(selectedRun.updatedAt)}
                  </p>
                </div>
                {selectedRunSession && (
                  <button
                    className="shrink-0 rounded-[14px] bg-aura-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-aura-glow transition hover:opacity-90"
                    onClick={() => void loadSession(selectedRunSession.id)}
                  >
                    Open Session
                  </button>
                )}
              </div>

              <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
                <div className="grid gap-3 sm:grid-cols-4">
                  <Metric label="Run id" value={selectedRun.runId ?? selectedRun.id} />
                  <Metric label="Tools" value={String(selectedRun.toolCount)} />
                  <Metric label="Started" value={formatDate(selectedRun.startedAt)} />
                  <Metric label="Updated" value={formatDate(selectedRun.updatedAt)} />
                </div>

                <div className="rounded-[22px] border border-white/8 bg-black/20 p-5">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">Outcome</p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-aura-text">
                    {selectedRun.summary ?? selectedRun.error ?? "This run completed without a saved summary yet."}
                  </p>
                </div>

                {selectedRunEvents.length > 0 && (
                  <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-5">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">Tool Trace</p>
                    <div className="mt-4">
                      <RunTimelineBubble run={selectedRun} events={selectedRunEvents} showAvatar={false} />
                    </div>
                  </div>
                )}

                {selectedRunSession && (
                  <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-5">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">Related Session</p>
                    <p className="mt-2 text-sm font-semibold text-aura-text">{selectedRunSession.title ?? "Conversation session"}</p>
                    <p className="mt-1 text-xs text-aura-muted">
                      {selectedRunSession.messages.length} messages · {selectedRunSession.pagesVisited.length} visited pages
                    </p>
                    {selectedRunSession.messages.length > 0 && (
                      <div className="mt-4 space-y-3">
                        {selectedRunSession.messages.slice(-4).map((message) => (
                          <div key={message.id} className="rounded-[16px] border border-white/8 bg-black/20 px-4 py-3">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-aura-muted">{message.role}</p>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-aura-text">{message.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <EmptyDetail message="Select a run to inspect its outcome and related session." />
          )
        ) : selectedSession ? (
          <>
            <div className="flex items-center justify-between border-b border-white/6 px-6 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-aura-text">{selectedSession.title ?? "Session"}</p>
                <p className="mt-0.5 text-xs text-aura-muted">{formatDate(selectedSession.startedAt)}</p>
              </div>
              <button
                className="shrink-0 rounded-[14px] bg-aura-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-aura-glow transition hover:opacity-90"
                onClick={() => void loadSession(selectedSession.id)}
              >
                Resume
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
              {selectedSession.messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-[18px] px-4 py-2.5 text-sm leading-relaxed ${
                      message.role === "user"
                        ? "rounded-br-md bg-aura-gradient text-white"
                        : "rounded-bl-md border border-white/8 bg-white/5 text-aura-text"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{message.content}</p>
                    <p className="mt-1 text-[10px] opacity-50">{formatDate(message.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyDetail message="Select a session to review the conversation." />
        )}
      </div>
    </div>
  );
};

const Metric = ({ label, value }: { label: string; value: string }): JSX.Element => (
  <div className="rounded-[18px] border border-white/8 bg-black/20 px-4 py-4">
    <p className="text-[10px] uppercase tracking-[0.16em] text-aura-muted">{label}</p>
    <p className="mt-2 truncate text-sm font-semibold text-aura-text">{value}</p>
  </div>
);

const EmptyDetail = ({ message }: { message: string }): JSX.Element => (
  <div className="flex h-full items-center justify-center px-8 text-center">
    <p className="text-sm text-aura-muted">{message}</p>
  </div>
);
