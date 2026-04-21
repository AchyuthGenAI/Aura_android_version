import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { normalizeTextContent } from "@shared/text-content";
import type { ChatThreadMessage, ThemeMode, ToastNotice } from "@shared/types";

const sizeMap = {
  xs: 28,
  sm: 40,
  md: 56,
  lg: 88
} as const;

export const AuraLogoBlob = ({
  size = "md",
  isTaskRunning = false
}: {
  size?: keyof typeof sizeMap;
  isTaskRunning?: boolean;
}): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }

    const base = 160;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = base * dpr;
    canvas.height = base * dpr;
    ctx.scale(dpr, dpr);

    let frame = 0;
    const cx = base / 2;
    const cy = base / 2;

    const drawBlob = (
      radius: number,
      color: string,
      speed: number,
      waveCount: number,
      amplitude: number,
      alpha: number
    ) => {
      ctx.beginPath();
      for (let angle = 0; angle <= Math.PI * 2 + 0.05; angle += 0.05) {
        const wave =
          Math.sin(angle * waveCount + frame * speed) * amplitude +
          (isTaskRunning ? Math.cos(angle * (waveCount + 2) - frame * speed * 1.4) * (amplitude * 0.45) : 0);
        const nextRadius = radius + wave;
        const x = cx + Math.cos(angle) * nextRadius;
        const y = cy + Math.sin(angle) * nextRadius;
        if (angle === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.fill();
    };

    const loop = () => {
      frame += isTaskRunning ? 0.038 : 0.02;
      ctx.clearRect(0, 0, base, base);
      ctx.globalCompositeOperation = "screen";
      drawBlob(46, "#7c3aed", 2.4, 3, 7, 0.78);
      drawBlob(42, "#ec4899", 2.9, 5, 5, 0.65);
      drawBlob(39, "#06b6d4", 2.1, 4, 5, 0.62);
      ctx.globalCompositeOperation = "source-over";
      drawBlob(16, "#ffffff", 3.8, 2, 2.4, 0.92);
      requestAnimationFrame(loop);
    };

    loop();
  }, [isTaskRunning]);

  const px = sizeMap[size];

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: px, height: px }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-[140%] w-[140%] -translate-x-[14%] -translate-y-[14%]"
      />
    </div>
  );
};

export const AuraFace = ({
  phase
}: {
  phase: "idle" | "listening" | "thinking" | "speaking";
}): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }

    const width = 360;
    const height = 360;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    let frame = 0;

    const loop = () => {
      frame += phase === "speaking" ? 0.05 : phase === "listening" ? 0.035 : 0.02;
      ctx.clearRect(0, 0, width, height);

      const gradient = ctx.createRadialGradient(180, 150, 30, 180, 180, 160);
      gradient.addColorStop(0, "rgba(124,58,237,0.55)");
      gradient.addColorStop(0.55, "rgba(99,102,241,0.28)");
      gradient.addColorStop(1, "rgba(6,182,212,0.02)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(180, 180, 150, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255,255,255,0.09)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(180, 180, 134, 0, Math.PI * 2);
      ctx.stroke();

      const eyeLift = phase === "thinking" ? -3 : 0;
      const mouthAmp = phase === "speaking" ? 12 : phase === "listening" ? 4 : 2;

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(140, 150 + eyeLift, 13, 13 + Math.sin(frame * 2) * 2, 0, 0, Math.PI * 2);
      ctx.ellipse(220, 150 + eyeLift, 13, 13 + Math.sin(frame * 2 + 1) * 2, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(128, 225);
      ctx.quadraticCurveTo(180, 225 + mouthAmp + Math.sin(frame * 3) * 3, 232, 225);
      ctx.stroke();
    };

    loop();
  }, [phase]);

  return (
    <div className="mx-auto flex h-[280px] w-[280px] items-center justify-center rounded-full border border-white/10 bg-white/5 shadow-aura-glow backdrop-blur-xl">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
};

export const MessageBubble = ({
  message,
  theme
}: {
  message: ChatThreadMessage;
  theme: ThemeMode;
}): JSX.Element => {
  const content = normalizeTextContent(message.content);
  const isStreaming = message.status === "streaming";

  const html = useMemo(() => {
    if (isStreaming) {
      return "";
    }
    const raw = marked.parse(content || "", { breaks: true }) as string;
    return DOMPurify.sanitize(raw);
  }, [content, isStreaming]);

  const isUser = message.role === "user";
  const isError = message.status === "error";

  return (
    <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[86%] gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
        {!isUser && (
          <div className="mt-1">
            <AuraLogoBlob size="xs" isTaskRunning={message.status === "streaming"} />
          </div>
        )}
        <div
          className={[
            "message-bubble prose prose-invert max-w-none rounded-[22px] px-4 py-3 text-sm leading-6 shadow-sm",
            isUser
              ? "rounded-br-md bg-aura-gradient text-white"
              : isError
                ? theme === "light"
                  ? "rounded-bl-md border border-red-300/60 bg-red-50 text-red-900"
                  : "rounded-bl-md border border-red-400/25 bg-red-500/10 text-red-100"
              : theme === "light"
                ? "rounded-bl-md border border-black/10 bg-white text-slate-800"
                : "rounded-bl-md border border-white/10 bg-white/6 text-aura-text",
            ""
          ].join(" ")}
        >
          {isStreaming ? (
            <div className="whitespace-pre-wrap break-words">
              {content}
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse align-middle bg-aura-violet" />
            </div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </div>
      </div>
    </div>
  );
};

export const PendingMessageBubble = ({
  title,
  detail
}: {
  title: string;
  detail?: string;
}): JSX.Element => {
  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[86%] gap-3">
        <div className="mt-1">
          <AuraLogoBlob size="xs" isTaskRunning />
        </div>
        <div className="rounded-[22px] rounded-bl-md border border-aura-violet/20 bg-white/6 px-4 py-3 text-aura-text shadow-sm">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-aura-violet/80">
              {title}
            </p>
            <div className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-aura-violet/80 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-aura-violet/80 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-aura-violet/80 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
          {detail && <p className="mt-2 text-xs leading-5 text-aura-muted">{detail}</p>}
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className="animate-shimmer h-full rounded-full bg-[linear-gradient(90deg,rgba(124,58,237,0.14),rgba(168,85,247,0.95),rgba(6,182,212,0.2))] bg-[length:200%_100%]"
              style={{ width: "46%" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export const StatusPill = ({
  label,
  tone = "default"
}: {
  label: string;
  tone?: "default" | "success" | "warning" | "error";
}): JSX.Element => {
  const className =
    tone === "success"
      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
      : tone === "warning"
        ? "border-amber-400/20 bg-amber-400/10 text-amber-100"
        : tone === "error"
          ? "border-red-400/20 bg-red-400/10 text-red-100"
          : "border-white/10 bg-white/6 text-aura-text";

  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${className}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
};

export const ToastViewport = ({
  toasts,
  onDismiss
}: {
  toasts: ToastNotice[];
  onDismiss: (id: string) => void;
}): JSX.Element => {
  useEffect(() => {
    const timers = toasts.map((toast) =>
      window.setTimeout(() => onDismiss(toast.id), 4200)
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [onDismiss, toasts]);

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[200] flex w-[min(420px,calc(100vw-24px))] -translate-x-1/2 flex-col items-center gap-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            "pointer-events-auto relative w-full overflow-hidden rounded-[28px] border px-4 py-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl",
            toast.tone === "success"
              ? "border-emerald-400/25 bg-[#08160f]/88"
              : toast.tone === "warning"
                ? "border-amber-400/25 bg-[#191208]/88"
                : toast.tone === "error"
                  ? "border-red-400/25 bg-[#19090b]/88"
                  : "border-white/10 bg-[#0f1018]/88"
          ].join(" ")}
        >
          <div className="absolute inset-x-0 top-0 h-[2px] bg-sky-300/70" />
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-sky-400/20 bg-sky-400/12 text-sky-100">
              <span className="text-sm font-semibold">i</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold tracking-[0.01em] text-aura-text">{toast.title}</p>
              {toast.message && <p className="mt-1 text-[12px] leading-5 text-aura-muted">{toast.message}</p>}
            </div>
            <button className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-aura-muted transition hover:bg-white/[0.09] hover:text-aura-text" onClick={() => onDismiss(toast.id)}>
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
