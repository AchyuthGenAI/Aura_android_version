import { useEffect, useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";

const TIMEOUT_SECONDS = 30;

export const ConfirmModal = (): JSX.Element | null => {
  const pendingConfirmation = useAuraStore((s) => s.pendingConfirmation);
  const confirmChatAction = useAuraStore((s) => s.confirmChatAction);
  const [countdown, setCountdown] = useState(TIMEOUT_SECONDS);

  useEffect(() => {
    if (!pendingConfirmation) return;
    setCountdown(TIMEOUT_SECONDS);
    const id = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [pendingConfirmation?.requestId]);

  useEffect(() => {
    if (countdown === 0 && pendingConfirmation) {
      void confirmChatAction(pendingConfirmation.requestId, "deny");
    }
  }, [countdown, pendingConfirmation, confirmChatAction]);

  if (!pendingConfirmation) return null;

  const { requestId, message, step } = pendingConfirmation;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative w-full max-w-[440px] overflow-hidden rounded-[28px] border border-amber-500/20 bg-[#1a1625] shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
        {/* Amber glow */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.1),transparent_60%)]" />

        <div className="relative px-6 py-5">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15">
              <span className="text-lg text-amber-400">⚠</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-aura-text">Action requires approval</p>
              <p className="text-xs text-aura-muted">Aura wants to perform a sensitive action</p>
            </div>
          </div>

          {/* Description */}
          <div className="mt-4 rounded-[16px] border border-white/8 bg-white/4 px-4 py-3">
            <p className="text-sm text-aura-text">{message}</p>
            {step?.tool && (
              <p className="mt-1.5 text-xs text-aura-muted">
                Tool: <span className="text-amber-400/80">{step.tool}</span>
                {step.params && typeof step.params === "object" && "selector" in step.params && typeof step.params.selector === "string" && (
                  <> · Target: <span className="text-aura-muted">{step.params.selector}</span></>
                )}
              </p>
            )}
          </div>

          {/* Countdown */}
          <p className="mt-3 text-center text-[11px] text-aura-muted">
            Auto-denying in <span className="font-mono text-amber-400">{countdown}s</span>
          </p>

          {/* Buttons */}
          <div className="mt-4 flex gap-3">
            <button
              className="flex-1 rounded-[16px] border border-white/10 bg-white/6 px-4 py-2.5 text-sm font-medium text-aura-text transition hover:bg-white/10"
              onClick={() => void confirmChatAction(requestId, "deny")}
            >
              Cancel
            </button>
            <button
              className="flex-1 rounded-[16px] bg-amber-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-amber-400"
              onClick={() => void confirmChatAction(requestId, "allow-once")}
            >
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
