import { useAuraStore } from "@renderer/store/useAuraStore";

export const SessionSidebar = (): JSX.Element => {
  const sessions = useAuraStore((s) => s.sessions);
  const currentSessionId = useAuraStore((s) => s.currentSessionId);
  const loadSession = useAuraStore((s) => s.loadSession);
  const startNewSession = useAuraStore((s) => s.startNewSession);
  const profile = useAuraStore((s) => s.profile);

  return (
    <div className="glass-panel relative flex h-full flex-col overflow-hidden rounded-[28px] px-5 py-5 shadow-[0_18px_60px_rgba(3,6,20,0.28)]">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-aura-text">Recent Chats</h2>
          <p className="mt-0.5 text-xs text-aura-muted">Resume previous conversations.</p>
        </div>
        <button
          onClick={() => void startNewSession()}
          className="rounded-2xl border border-white/10 bg-white/8 px-3 py-1.5 text-xs font-semibold text-aura-text transition hover:bg-white/12"
        >
          + New
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="rounded-[22px] border border-dashed border-white/10 bg-white/4 px-4 py-6 text-sm text-aura-muted">
            Your recent chats will appear here once you start using Aura.
          </div>
        ) : (
          sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => void loadSession(session.id)}
              className={`w-full rounded-[22px] border px-4 py-3.5 text-left transition ${
                session.id === currentSessionId
                  ? "border-aura-violet/40 bg-aura-violet/12"
                  : "border-white/8 bg-white/5 hover:bg-white/8"
              }`}
            >
              <p className="truncate text-sm font-semibold text-aura-text">
                {session.title || "Untitled session"}
              </p>
              <p className="mt-1 text-xs text-aura-muted">
                {session.messages.length} msg · {new Date(session.startedAt).toLocaleDateString()}
              </p>
            </button>
          ))
        )}
      </div>

      <div className="mt-5 rounded-[22px] border border-white/10 bg-white/4 p-4">
        <p className="text-[10px] uppercase tracking-[0.22em] text-aura-muted">Signed in</p>
        <p className="mt-2 text-sm font-semibold text-aura-text">{profile.fullName || "Aura user"}</p>
        <p className="mt-0.5 text-xs text-aura-muted">{profile.email || "No email saved yet"}</p>
      </div>
    </div>
  );
};
