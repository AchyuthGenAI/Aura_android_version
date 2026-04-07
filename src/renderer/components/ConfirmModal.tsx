import { useEffect, useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";

const TIMEOUT_SECONDS = 30;

export const ConfirmModal = (): JSX.Element | null => {
  const pendingConfirmation = useAuraStore((state) => state.pendingConfirmation);
  const confirmChatAction = useAuraStore((state) => state.confirmChatAction);
  const [countdown, setCountdown] = useState(TIMEOUT_SECONDS);

  useEffect(() => {
    if (!pendingConfirmation) return;
    setCountdown(TIMEOUT_SECONDS);
    const id = setInterval(() => setCountdown((current) => Math.max(0, current - 1)), 1000);
    return () => clearInterval(id);
  }, [pendingConfirmation?.requestId]);

  useEffect(() => {
    if (countdown === 0 && pendingConfirmation) {
      void confirmChatAction(pendingConfirmation.requestId, "deny");
    }
  }, [countdown, pendingConfirmation, confirmChatAction]);

  if (!pendingConfirmation) return null;

  const { requestId, message, step } = pendingConfirmation;
  const command = typeof step.params?.command === "string" ? step.params.command : null;
  const cwd = typeof step.params?.cwd === "string" ? step.params.cwd : null;
  const host = typeof step.params?.host === "string" ? step.params.host : null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div className="relative w-full max-w-[520px] overflow-hidden rounded-[28px] border border-amber-500/20 bg-[#1a1625] shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.1),transparent_60%)]" />

        <div className="relative px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15">
              <span className="text-lg font-semibold text-amber-400">!</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-aura-text">Action requires approval</p>
              <p className="text-xs text-aura-muted">Aura wants to run a sensitive desktop action.</p>
            </div>
          </div>

          <div className="mt-4 rounded-[16px] border border-white/8 bg-white/4 px-4 py-3">
            <p className="text-sm leading-6 text-aura-text">{message}</p>
            {step?.tool && (
              <p className="mt-2 text-xs text-aura-muted">
                Tool: <span className="text-amber-300">{step.tool}</span>
              </p>
            )}
            {command && (
              <div className="mt-3 rounded-[12px] border border-white/8 bg-black/20 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-aura-muted">Command</p>
                <code className="mt-1 block whitespace-pre-wrap break-all text-xs leading-5 text-aura-text">{command}</code>
              </div>
            )}
            {(host || cwd) && (
              <p className="mt-2 text-xs leading-5 text-aura-muted">
                {host ? <>Host: <span className="text-aura-text">{host}</span></> : null}
                {host && cwd ? <> | </> : null}
                {cwd ? <>CWD: <span className="text-aura-text">{cwd}</span></> : null}
              </p>
            )}
          </div>

          <p className="mt-3 text-center text-[11px] text-aura-muted">
            Auto-denying in <span className="font-mono text-amber-400">{countdown}s</span>
          </p>

          <div className="mt-4 flex gap-3">
            <button
              className="flex-1 rounded-[16px] border border-white/10 bg-white/6 px-4 py-2.5 text-sm font-medium text-aura-text transition hover:bg-white/10"
              onClick={() => void confirmChatAction(requestId, "deny")}
            >
              Deny
            </button>
            <button
              className="flex-1 rounded-[16px] border border-amber-400/20 bg-amber-500/15 px-4 py-2.5 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/25"
              onClick={() => void confirmChatAction(requestId, "allow-once")}
            >
              Allow once
            </button>
            <button
              className="flex-1 rounded-[16px] bg-amber-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-amber-400"
              onClick={() => void confirmChatAction(requestId, "allow-always")}
            >
              Allow always
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
