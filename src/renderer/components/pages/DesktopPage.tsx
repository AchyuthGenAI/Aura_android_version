import { useState } from "react";

import type { DesktopScreenshotResult } from "@shared/types";

const QUICK_APPS = [
  { label: "Notepad", target: "notepad.exe", icon: "📝" },
  { label: "Calculator", target: "calc.exe", icon: "🔢" },
  { label: "Explorer", target: "explorer.exe", icon: "📁" },
  { label: "Paint", target: "mspaint.exe", icon: "🎨" },
  { label: "Terminal", target: "cmd.exe", icon: "⌨" },
  { label: "Browser", target: "msedge.exe", icon: "🌐" },
];

const DESKTOP_EXAMPLES = [
  '"Open WhatsApp and send Hi to John"',
  '"Take a screenshot and describe what you see"',
  '"Open Notepad and type a shopping list"',
  '"Search Google for today\'s weather"',
  '"Click the Start button and open Settings"',
];

export const DesktopPage = (): JSX.Element => {
  const [screenshot, setScreenshot] = useState<DesktopScreenshotResult | null>(null);
  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setLoading(true);
    setStatus(`${label}...`);
    setLastAction(null);
    try {
      const result = await fn();
      setStatus("Ready");
      if (typeof result === "string" && result) setLastAction(result);
      else setLastAction(`${label} — done`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus("Error");
      setLastAction(`Error: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const captureScreenshot = async (): Promise<void> => {
    await run("Capturing screenshot", async () => {
      const result = await window.auraDesktop.desktop.screenshot();
      setScreenshot(result);
      return `Captured ${result.width}×${result.height} screenshot`;
    });
  };

  const openApp = async (target: string, label: string): Promise<void> => {
    await run(`Opening ${label}`, async () => {
      await window.auraDesktop.desktop.openApp({ target });
      return `Opened ${label}`;
    });
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pb-8">
      {/* Header */}
      <div>
        <h1 className="text-[28px] font-bold tracking-tight text-white">Desktop Control</h1>
        <p className="mt-1 text-[14px] leading-relaxed text-aura-muted">
          Aura can see and control your entire Windows desktop — just tell it what to do in chat.
        </p>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div className={`h-2 w-2 shrink-0 rounded-full transition-all ${
          loading ? "animate-pulse bg-aura-violet" :
          status === "Error" ? "bg-red-400" : "bg-emerald-400"
        }`} />
        <p className="flex-1 text-[13px] text-aura-muted">{status}</p>
        {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-aura-violet/30 border-t-aura-violet" />}
      </div>

      {/* Last action result */}
      {lastAction && (
        <div className={`rounded-[18px] border px-4 py-3 text-[13px] ${
          lastAction.startsWith("Error")
            ? "border-red-400/20 bg-red-500/8 text-red-300"
            : "border-emerald-400/20 bg-emerald-500/8 text-emerald-300"
        }`}>
          {lastAction}
        </div>
      )}

      {/* Screenshot action + preview */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-aura-muted">Screenshot</p>
          {screenshot && (
            <p className="text-[11px] text-aura-muted/60">
              {screenshot.width}×{screenshot.height} · {new Date(screenshot.capturedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          disabled={loading}
          onClick={captureScreenshot}
          className="flex items-center gap-3 rounded-[20px] border border-aura-violet/30 bg-aura-violet/10 px-5 py-4 text-left transition hover:bg-aura-violet/20 disabled:opacity-50"
        >
          <span className="text-[22px]">⊡</span>
          <div>
            <p className="text-[13px] font-semibold text-aura-text">Capture Full Screen</p>
            <p className="text-[11px] text-aura-muted">Take a snapshot of the current desktop state</p>
          </div>
        </button>

        {screenshot && (
          <div className="relative overflow-hidden rounded-[20px] border border-white/[0.06]">
            <img
              src={screenshot.dataUrl}
              alt="Desktop screenshot"
              className={`w-full cursor-pointer object-contain transition-all ${fullscreen ? "max-h-none" : "max-h-[260px]"}`}
              onClick={() => setFullscreen((f) => !f)}
            />
            <button
              onClick={() => setFullscreen((f) => !f)}
              className="absolute right-3 top-3 rounded-[10px] border border-white/10 bg-black/60 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm transition hover:bg-black/80"
            >
              {fullscreen ? "Collapse" : "Expand"}
            </button>
          </div>
        )}
      </div>

      {/* Quick app launchers */}
      <div className="flex flex-col gap-3">
        <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-aura-muted">Quick Launch</p>
        <div className="grid grid-cols-3 gap-2.5">
          {QUICK_APPS.map((app) => (
            <button
              key={app.target}
              disabled={loading}
              onClick={() => void openApp(app.target, app.label)}
              className="flex flex-col items-center gap-2 rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-4 text-center transition hover:border-white/[0.12] hover:bg-white/[0.05] disabled:opacity-50"
            >
              <span className="text-[26px]">{app.icon}</span>
              <span className="text-[12px] font-medium text-aura-text">{app.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Vision agent examples */}
      <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="flex items-center gap-2">
          <span className="text-[16px]">👁</span>
          <p className="text-[13px] font-semibold text-aura-text">Vision Agent — Chat Examples</p>
        </div>
        <p className="mt-1.5 text-[12px] text-aura-muted">
          Type any of these in chat and Aura will take over your desktop:
        </p>
        <div className="mt-3 space-y-2">
          {DESKTOP_EXAMPLES.map((example) => (
            <div key={example} className="flex items-start gap-2 text-[12px] text-aura-muted">
              <span className="mt-0.5 shrink-0 text-aura-violet">›</span>
              <span className="font-mono">{example}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
