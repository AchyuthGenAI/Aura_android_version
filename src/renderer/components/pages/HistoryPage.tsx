import { useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";
import { SectionHeading } from "../shared";
import type { AuraSession } from "@shared/types";

const formatDate = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isYesterday =
    new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
};

export const HistoryPage = (): JSX.Element => {
  const sessions = useAuraStore((s) => s.sessions);
  const loadSession = useAuraStore((s) => s.loadSession);
  const [selected, setSelected] = useState<AuraSession | null>(
    sessions[0] ?? null,
  );
  const [displayCount, setDisplayCount] = useState(20);

  const displayedSessions = sessions.slice(0, displayCount);

  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet shadow-[0_0_30px_rgba(124,58,237,0.15)]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <div>
          <p className="text-[16px] font-bold text-aura-text">No history yet</p>
          <p className="mt-1 max-w-[280px] text-[13px] leading-relaxed text-aura-muted">
            Your sessions will appear here after you start chatting with Aura.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-5 overflow-hidden p-2">
      {/* ── Left sidebar — Session list ──────────────────────────────── */}
      <div className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.02] to-transparent">
        <div className="border-b border-white/[0.06] px-5 py-4">
          <SectionHeading
            title="Sessions"
            detail={`${sessions.length} total`}
          />
        </div>
        <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-3">
          {displayedSessions.map((session) => {
            const isActive = selected?.id === session.id;
            return (
              <button
                key={session.id}
                onClick={() => setSelected(session)}
                className={`group relative w-full overflow-hidden rounded-[16px] border px-4 py-3 text-left transition-all duration-200 ${
                  isActive
                    ? "border-aura-violet/30 bg-aura-violet/[0.08] text-aura-text"
                    : "border-transparent bg-transparent text-aura-muted hover:border-white/[0.06] hover:bg-white/[0.03] hover:text-aura-text"
                }`}
              >
                {isActive && (
                  <div className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-aura-violet" />
                )}
                <p className="truncate text-[14px] font-semibold">
                  {session.title ??
                    session.messages[0]?.content?.slice(0, 50) ??
                    "Session"}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-aura-muted/70">
                  <span>{formatDate(session.startedAt)}</span>
                  <span className="opacity-40">·</span>
                  <span>
                    {session.messages.length} msg
                    {session.messages.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </button>
            );
          })}
          {displayCount < sessions.length && (
            <button
              onClick={() => setDisplayCount((prev) => prev + 20)}
              className="mt-2 w-full rounded-[14px] bg-white/[0.03] py-2.5 text-[13px] font-semibold text-aura-muted transition-all hover:bg-white/[0.06] hover:text-aura-text"
            >
              Load older sessions...
            </button>
          )}
        </div>
      </div>

      {/* ── Right pane — Session detail ──────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.02] to-transparent">
        {selected ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-bold text-aura-text">
                  {selected.title ?? "Session"}
                </p>
                <p className="mt-0.5 text-[12px] text-aura-muted">
                  {formatDate(selected.startedAt)} ·{" "}
                  {selected.messages.length} messages
                </p>
              </div>
              <button
                className="group flex shrink-0 items-center gap-2 rounded-[14px] bg-aura-gradient px-4 py-2 text-[13px] font-semibold text-white shadow-[0_4px_16px_rgba(124,58,237,0.3)] transition-all hover:shadow-[0_6px_24px_rgba(124,58,237,0.4)]"
                onClick={() => void loadSession(selected.id)}
              >
                Resume
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>

            {/* Messages */}
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-5">
              {selected.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-[18px] px-4 py-3 text-[14px] leading-relaxed shadow-sm ${
                      msg.role === "user"
                        ? "rounded-br-md bg-aura-gradient text-white shadow-[0_4px_16px_rgba(124,58,237,0.2)]"
                        : "rounded-bl-md border border-white/[0.06] bg-white/[0.04] text-aura-text"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    <p className="mt-1.5 text-[10px] opacity-40">
                      {formatDate(msg.timestamp)}
                    </p>
                  </div>
                </div>
              ))}
              {selected.messages.length === 0 && (
                <div className="flex h-full items-center justify-center">
                  <p className="text-[13px] text-aura-muted">
                    No messages in this session.
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-[14px] text-aura-muted">
              Select a session to view it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
