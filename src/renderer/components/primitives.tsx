import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";


const normalizeTextContent = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) return String((value as { text: unknown }).text);
  return value ? String(value) : "";
};
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
    const raw = marked.parse(content || "", { breaks: true }) as string;
    const sanitized = DOMPurify.sanitize(raw);
    if (isStreaming) {
      return sanitized + `<span class="ml-1 inline-block h-3.5 w-1 animate-pulse align-baseline bg-[#bca5ff]"></span>`;
    }
    return sanitized;
  }, [content, isStreaming]);

  const isUser = message.role === "user";

  return (
    <div className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[86%] gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
        {!isUser && (
          <div className="mt-1 flex-shrink-0">
            <AuraLogoBlob size="xs" isTaskRunning={message.status === "streaming"} />
          </div>
        )}
        {isUser && (
          <div className="mt-1 flex flex-shrink-0 h-[28px] w-[28px] items-center justify-center rounded-full bg-gradient-to-br from-[#7c3aed] to-[#06b6d4] text-white shadow-md ring-1 ring-white/10">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </div>
        )}
        <div
          className={[
            "message-bubble msg-enter prose prose-invert max-w-none px-4 py-[10px] text-[14.5px] leading-relaxed shadow-sm",
            isUser
              ? "rounded-[22px] rounded-br-[6px] bg-aura-gradient text-white shadow-[0_4px_16px_rgba(124,58,237,0.15)]"
              : theme === "light"
                ? "rounded-[22px] rounded-bl-[6px] border border-black/10 bg-white text-slate-800"
                : "rounded-[22px] rounded-bl-[6px] border border-white/10 bg-[#1e1c2e] text-aura-text shadow-[0_4px_24px_rgba(0,0,0,0.1)]",
            ""
          ].join(" ")}
          // By standardizing dangerouslySetInnerHTML, we can safely style raw HTML regardless of streaming state.
          dangerouslySetInnerHTML={{ __html: html }}
        />
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
    <div className="flex w-full justify-start msg-enter">
      <div className="flex max-w-[86%] gap-3">
        <div className="mt-1 flex-shrink-0">
          <AuraLogoBlob size="xs" isTaskRunning />
        </div>
        <div className="rounded-[22px] rounded-bl-[6px] border border-aura-violet/20 bg-[#1e1c2e] px-4 py-2.5 text-aura-text shadow-[0_4px_24px_rgba(124,58,237,0.08)]">
          <div className="flex items-center gap-[6px]">
            <p className="text-[11px] font-bold uppercase tracking-widest text-[#bca5ff]">
              {title}
            </p>
            <div className="flex items-center gap-[3px] mt-[1px]">
              <span className="h-[4px] w-[4px] rounded-full bg-[#bca5ff] animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="h-[4px] w-[4px] rounded-full bg-[#bca5ff] animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="h-[4px] w-[4px] rounded-full bg-[#bca5ff] animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
          {detail && <p className="mt-1 text-[13px] text-aura-muted leading-snug truncate max-w-[200px]">{detail}</p>}
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
    <div className="pointer-events-none fixed right-5 top-5 z-[200] flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            "pointer-events-auto rounded-2xl border px-4 py-3 shadow-aura-glow backdrop-blur-xl",
            toast.tone === "success"
              ? "border-emerald-400/20 bg-emerald-500/12"
              : toast.tone === "warning"
                ? "border-amber-400/20 bg-amber-500/12"
                : toast.tone === "error"
                  ? "border-red-400/20 bg-red-500/12"
                  : "border-white/10 bg-white/8"
          ].join(" ")}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-aura-text">{toast.title}</p>
              {toast.message && <p className="mt-1 text-xs leading-5 text-aura-muted">{toast.message}</p>}
            </div>
            <button className="text-aura-muted transition hover:text-aura-text" onClick={() => onDismiss(toast.id)}>
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
