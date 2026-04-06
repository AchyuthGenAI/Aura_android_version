import { useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";
import { SectionHeading } from "../shared";

const formatDate = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isYesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
};

export const HistoryPage = (): JSX.Element => {
  const sessions = useAuraStore((s) => s.sessions);
  const loadSession = useAuraStore((s) => s.loadSession);
  const [selectedId, setSelectedId] = useState<string | null>(sessions[0]?.id ?? null);
  const selected = sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null;

  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-4xl">🕐</p>
        <p className="text-sm font-medium text-aura-text">No history yet</p>
        <p className="text-xs text-aura-muted">Your sessions will appear here after you start chatting.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-5 overflow-hidden">
      {/* Left — Session list */}
      <div className="flex w-[300px] shrink-0 flex-col gap-2 overflow-y-auto">
        <SectionHeading title="Sessions" detail={`${sessions.length} total`} />
        <div className="mt-1 flex flex-col gap-2">
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => setSelectedId(session.id)}
              className={`w-full rounded-[20px] border px-4 py-3 text-left transition-all ${
                selected?.id === session.id
                  ? "border-aura-violet/30 bg-aura-violet/10 text-aura-text"
                  : "border-white/6 bg-white/3 text-aura-muted hover:bg-white/6 hover:text-aura-text"
              }`}
            >
              <p className="truncate text-sm font-medium">
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
      </div>

      {/* Right — Session detail */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-white/6 bg-white/2">
        {selected ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/6 px-6 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-aura-text">
                  {selected.title ?? "Session"}
                </p>
                <p className="mt-0.5 text-xs text-aura-muted">{formatDate(selected.startedAt)}</p>
              </div>
              <button
                className="shrink-0 rounded-[14px] bg-aura-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-aura-glow transition hover:opacity-90"
                onClick={() => void loadSession(selected.id)}
              >
                Resume →
              </button>
            </div>

            {/* Messages */}
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
              {selected.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-[18px] px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "rounded-br-md bg-aura-gradient text-white"
                        : "rounded-bl-md border border-white/8 bg-white/5 text-aura-text"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    <p className="mt-1 text-[10px] opacity-50">{formatDate(msg.timestamp)}</p>
                  </div>
                </div>
              ))}
              {selected.messages.length === 0 && (
                <p className="text-center text-xs text-aura-muted">No messages in this session.</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-aura-muted">Select a session to view it.</p>
          </div>
        )}
      </div>
    </div>
  );
};
