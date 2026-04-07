import { useMemo } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";
import type { RuntimeStatus, TaskErrorPayload } from "@shared/types";

type BannerTone = "error" | "warning" | "info";

interface BannerAction {
  label: string;
  onClick: () => void | Promise<void>;
}

interface RuntimeRecoveryBannerProps {
  compact?: boolean;
  primaryAction?: BannerAction;
  secondaryAction?: BannerAction;
}

interface BannerContent {
  title: string;
  message: string;
  tone: BannerTone;
  supportNote?: string;
  commandHint?: string;
  dismissible: boolean;
}

const getLastErrorBanner = (
  error: TaskErrorPayload,
  runtimeStatus: RuntimeStatus,
): BannerContent => {
  const supportNote = runtimeStatus.diagnostics?.supportNote;

  switch (error.code) {
    case "PAIRING_REQUIRED":
      return {
        title: "OpenClaw approval needed",
        message: error.message,
        tone: "warning",
        supportNote,
        commandHint: "openclaw devices approve --latest",
        dismissible: true,
      };
    case "RATE_LIMIT":
      return {
        title: "Provider rate limit reached",
        message: error.message,
        tone: "warning",
        supportNote,
        dismissible: true,
      };
    case "BROWSER_UNAVAILABLE":
      return {
        title: "Browser control is still starting",
        message: error.message,
        tone: "info",
        supportNote,
        dismissible: true,
      };
    case "TIMEOUT":
      return {
        title: "Request timed out",
        message: error.message,
        tone: "warning",
        supportNote,
        dismissible: true,
      };
    case "AI_UNAVAILABLE":
      return {
        title: "Managed runtime unavailable",
        message: error.message,
        tone: "error",
        supportNote,
        dismissible: true,
      };
    case "PERMISSION_DENIED":
      return {
        title: "Permission required",
        message: error.message,
        tone: "warning",
        supportNote,
        dismissible: true,
      };
    case "TASK_CANCELLED":
      return {
        title: "Response stopped",
        message: error.message,
        tone: "info",
        supportNote,
        dismissible: true,
      };
    default:
      return {
        title: "Task failed",
        message: error.message,
        tone: "error",
        supportNote,
        dismissible: true,
      };
  }
};

const getRuntimeBanner = (runtimeStatus: RuntimeStatus): BannerContent | null => {
  if (runtimeStatus.phase !== "error" && !runtimeStatus.degraded) {
    return null;
  }

  return {
    title: runtimeStatus.phase === "error" ? "Runtime needs attention" : "Runtime is reconnecting",
    message: runtimeStatus.error ?? runtimeStatus.message,
    tone: runtimeStatus.phase === "error" ? "error" : "warning",
    supportNote: runtimeStatus.diagnostics?.supportNote,
    dismissible: false,
  };
};

const toneClassMap: Record<BannerTone, string> = {
  error: "border-red-400/20 bg-red-500/10 text-red-50",
  warning: "border-amber-400/20 bg-amber-500/10 text-amber-50",
  info: "border-sky-400/20 bg-sky-500/10 text-sky-50",
};

const dotClassMap: Record<BannerTone, string> = {
  error: "bg-red-300",
  warning: "bg-amber-300",
  info: "bg-sky-300",
};

export const RuntimeRecoveryBanner = ({
  compact = false,
  primaryAction,
  secondaryAction,
}: RuntimeRecoveryBannerProps): JSX.Element | null => {
  const lastError = useAuraStore((state) => state.lastError);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const clearLastError = useAuraStore((state) => state.clearLastError);

  const content = useMemo(() => {
    if (lastError) {
      return getLastErrorBanner(lastError, runtimeStatus);
    }
    return getRuntimeBanner(runtimeStatus);
  }, [lastError, runtimeStatus]);

  if (!content) {
    return null;
  }

  const actionClass =
    "rounded-full border border-white/12 bg-white/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-white transition hover:bg-white/16";

  return (
    <div className={`rounded-[24px] border px-4 py-4 shadow-[0_10px_30px_rgba(0,0,0,0.22)] ${toneClassMap[content.tone]}`}>
      <div className={`flex ${compact ? "flex-col gap-3" : "items-start justify-between gap-4"}`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${dotClassMap[content.tone]}`} />
            <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-white/80">{content.title}</p>
          </div>
          <p className="mt-2 text-sm leading-6 text-white">{content.message}</p>
          {content.supportNote && (
            <p className="mt-2 text-[12px] leading-5 text-white/75">{content.supportNote}</p>
          )}
          {content.commandHint && (
            <div className="mt-3 rounded-[16px] border border-white/10 bg-black/20 px-3 py-2 font-mono text-[12px] text-white/90">
              {content.commandHint}
            </div>
          )}
        </div>

        {content.dismissible && (
          <button
            className="self-start rounded-full border border-white/10 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/80 transition hover:bg-white/14 hover:text-white"
            onClick={() => clearLastError()}
          >
            Dismiss
          </button>
        )}
      </div>

      {(primaryAction || secondaryAction) && (
        <div className={`mt-4 flex ${compact ? "flex-col gap-2" : "flex-wrap gap-2"}`}>
          {primaryAction && (
            <button className={actionClass} onClick={() => void primaryAction.onClick()}>
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button className={actionClass} onClick={() => void secondaryAction.onClick()}>
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
