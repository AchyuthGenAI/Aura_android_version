import { useState } from "react";

import type { DesktopScreenshotResult } from "@shared/types";

const QUICK_APPS = [
  { label: "Notepad", target: "notepad.exe" },
  { label: "Calculator", target: "calc.exe" },
  { label: "Explorer", target: "explorer.exe" },
  { label: "Paint", target: "mspaint.exe" },
  { label: "Terminal", target: "cmd.exe" },
];

export const DesktopPage = (): JSX.Element => {
  const [screenshot, setScreenshot] = useState<DesktopScreenshotResult | null>(null);
  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setLoading(true);
    setStatus(`${label}...`);
    try {
      await fn();
      setStatus(`${label} — done`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const captureScreenshot = async (): Promise<void> => {
    await run("Capturing screenshot", async () => {
      const result = await window.auraDesktop.desktop.screenshot();
      setScreenshot(result);
    });
  };

  const openApp = async (target: string, label: string): Promise<void> => {
    await run(`Opening ${label}`, () => window.auraDesktop.desktop.openApp({ target }));
  };

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pb-8">
      <div className="flex flex-col">
        <h1 className="text-[28px] font-bold tracking-tight text-white">Desktop Control</h1>
        <p className="mt-1 text-[14px] text-aura-muted">
          Aura can take full control of your Windows desktop — screenshots, mouse, keyboard, and apps.
          Use the chat to give automation commands, or try the controls below.
        </p>
      </div>

      {/* Status strip */}
      <div className="flex items-center gap-3 rounded-[20px] border border-white/[0.06] bg-white/[0.02] px-5 py-3">
        <div className={`h-2 w-2 shrink-0 rounded-full ${loading ? "animate-pulse bg-aura-violet" : "bg-emerald-400"}`} />
        <p className="text-[13px] text-aura-muted">{status}</p>
      </div>

      {/* Quick actions */}
      <div className="flex flex-col gap-3">
        <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-aura-muted">Quick Actions</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <button
            disabled={loading}
            onClick={captureScreenshot}
            className="flex items-center gap-3 rounded-[20px] border border-aura-violet/30 bg-aura-violet/10 px-4 py-3.5 text-left transition hover:bg-aura-violet/20 disabled:opacity-50"
          >
            <span className="text-[20px]">⊡</span>
            <span className="text-[13px] font-semibold text-aura-text">Take Screenshot</span>
          </button>

          {QUICK_APPS.map((app) => (
            <button
              key={app.target}
              disabled={loading}
              onClick={() => void openApp(app.target, app.label)}
              className="flex items-center gap-3 rounded-[20px] border border-white/[0.06] bg-white/[0.02] px-4 py-3.5 text-left transition hover:border-white/[0.12] hover:bg-white/[0.05] disabled:opacity-50"
            >
              <span className="text-[20px]">▶</span>
              <span className="text-[13px] font-semibold text-aura-text">Open {app.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Screenshot preview */}
      {screenshot && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-aura-muted">Last Screenshot</p>
            <p className="text-[11px] text-aura-muted/60">
              {screenshot.width}×{screenshot.height} · {new Date(screenshot.capturedAt).toLocaleTimeString()}
            </p>
          </div>
          <div className="overflow-hidden rounded-[20px] border border-white/[0.06]">
            <img
              src={screenshot.dataUrl}
              alt="Desktop screenshot"
              className="w-full object-contain"
            />
          </div>
        </div>
      )}

      {/* Info box */}
      <div className="rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5">
        <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">How to use via Chat</p>
        <div className="mt-3 space-y-2">
          {[
            '"Open Notepad" → launches Notepad via shell',
            '"Open Calculator" → launches Windows Calculator',
            '"Take a screenshot" → captures full screen',
            '"Click at 500, 300" → moves mouse + clicks',
            '"Type Hello World" → types text at cursor',
          ].map((example) => (
            <div key={example} className="flex items-start gap-2 text-[13px] text-aura-muted">
              <span className="mt-0.5 shrink-0 text-aura-violet">›</span>
              <span>{example}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
