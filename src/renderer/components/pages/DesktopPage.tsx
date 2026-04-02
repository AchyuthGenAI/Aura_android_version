import { useState } from "react";

import type { DesktopScreenshotResult } from "@shared/types";
import { useAuraStore } from "@renderer/store/useAuraStore";

import { Button, Card, SectionHeading } from "../shared";

const QUICK_APPS = [
  { label: "Notepad", target: "notepad.exe", accent: "NP" },
  { label: "Calculator", target: "calc.exe", accent: "CL" },
  { label: "Explorer", target: "explorer.exe", accent: "EX" },
  { label: "Paint", target: "mspaint.exe", accent: "PT" },
  { label: "Terminal", target: "cmd.exe", accent: "TM" },
  { label: "Browser", target: "msedge.exe", accent: "WB" },
];

const DESKTOP_EXAMPLES = [
  "Open WhatsApp and send Hi to John.",
  "Take a screenshot and describe what you see.",
  "Open Notepad and type a shopping list.",
  "Search Google for today's weather.",
  "Open Settings and show me the network panel.",
];

export const DesktopPage = (): JSX.Element => {
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
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
      if (typeof result === "string" && result) {
        setLastAction(result);
      } else {
        setLastAction(`${label} complete.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("Error");
      setLastAction(`Error: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const captureScreenshot = async (): Promise<void> => {
    await run("Capturing desktop", async () => {
      const result = await window.auraDesktop.desktop.screenshot();
      setScreenshot(result);
      return `Captured ${result.width}x${result.height} desktop snapshot.`;
    });
  };

  const openApp = async (target: string, label: string): Promise<void> => {
    await run(`Opening ${label}`, async () => {
      await window.auraDesktop.desktop.openApp({ target });
      return `${label} launched.`;
    });
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pb-8">
      <Card className="rounded-[30px] border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_36%),rgba(26,25,38,0.84)] px-6 py-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-[11px] uppercase tracking-[0.26em] text-[#86efac]">Desktop</p>
            <h1 className="mt-3 text-[30px] font-semibold tracking-tight text-white">Run full desktop workflows through the same managed OpenClaw runtime.</h1>
            <p className="mt-3 text-sm leading-6 text-aura-muted">
              Use this surface to launch quick actions, inspect the desktop state, and hand off more complex flows to chat without exposing raw setup or runtime details.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[420px]">
            <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">Runtime</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{runtimeStatus.gatewayConnected ? "OpenClaw connected" : "Needs attention"}</p>
              <p className="mt-1 text-xs leading-5 text-aura-muted">{runtimeStatus.message}</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">Control mode</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">Desktop automation</p>
              <p className="mt-1 text-xs leading-5 text-aura-muted">OpenClaw can click, type, scroll, launch apps, and resume work from chat.</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-4">
              <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">Last capture</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{screenshot ? `${screenshot.width}x${screenshot.height}` : "No screenshot yet"}</p>
              <p className="mt-1 text-xs leading-5 text-aura-muted">{screenshot ? new Date(screenshot.capturedAt).toLocaleTimeString() : "Capture a snapshot to confirm the desktop state."}</p>
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button className="bg-aura-gradient text-white shadow-aura-glow" onClick={() => void captureScreenshot()} disabled={loading}>
            Capture desktop
          </Button>
          <Button
            className="border border-white/10 bg-white/6 text-aura-text hover:bg-white/12"
            onClick={() => void sendMessage("text", "Inspect my desktop, summarize what is open, and ask before taking any risky action.")}
          >
            Inspect with OpenClaw
          </Button>
          <Button
            className="border border-white/10 bg-white/6 text-aura-text hover:bg-white/12"
            onClick={() => void sendMessage("text", "Help me automate a repetitive desktop workflow and turn it into a reusable job.")}
          >
            Design automation
          </Button>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="rounded-[30px] px-5 py-5">
          <SectionHeading
            title="Desktop Snapshot"
            detail="Capture the current screen, verify what OpenClaw should act on, and keep the interaction grounded in what is actually visible."
          />
          <div className="mt-4 flex items-center gap-3 rounded-[20px] border border-white/6 bg-white/[0.03] px-4 py-3">
            <div className={`h-2.5 w-2.5 rounded-full ${loading ? "animate-pulse bg-aura-violet" : status === "Error" ? "bg-red-400" : "bg-emerald-400"}`} />
            <p className="flex-1 text-sm text-aura-muted">{status}</p>
            {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-aura-violet/30 border-t-aura-violet" />}
          </div>

          {lastAction && (
            <div className={`mt-4 rounded-[18px] border px-4 py-3 text-sm ${
              lastAction.startsWith("Error")
                ? "border-red-400/20 bg-red-500/8 text-red-300"
                : "border-emerald-400/20 bg-emerald-500/8 text-emerald-300"
            }`}>
              {lastAction}
            </div>
          )}

          <div className="mt-4">
            {screenshot ? (
              <div className="relative overflow-hidden rounded-[24px] border border-white/8 bg-black/20">
                <img
                  src={screenshot.dataUrl}
                  alt="Desktop screenshot"
                  className={`w-full cursor-pointer object-contain transition-all ${fullscreen ? "max-h-none" : "max-h-[420px]"}`}
                  onClick={() => setFullscreen((value) => !value)}
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/75 to-transparent px-4 py-4 text-xs text-white">
                  <span>{screenshot.width}x{screenshot.height} at {new Date(screenshot.capturedAt).toLocaleTimeString()}</span>
                  <button
                    onClick={() => setFullscreen((value) => !value)}
                    className="rounded-[10px] border border-white/12 bg-black/40 px-3 py-1.5 transition hover:bg-black/60"
                  >
                    {fullscreen ? "Collapse" : "Expand"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-[24px] border border-dashed border-white/10 bg-black/15 px-6 py-12 text-center">
                <p className="text-sm font-medium text-aura-text">No desktop snapshot yet</p>
                <p className="mt-2 text-sm leading-6 text-aura-muted">
                  Capture the desktop when you want to confirm what OpenClaw should see before you hand off a task.
                </p>
              </div>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="rounded-[30px] px-5 py-5">
            <SectionHeading
              title="Quick Launch"
              detail="Open common tools fast, then hand the workflow over to chat when it becomes multi-step."
            />
            <div className="mt-4 grid grid-cols-2 gap-3">
              {QUICK_APPS.map((app) => (
                <button
                  key={app.target}
                  disabled={loading}
                  onClick={() => void openApp(app.target, app.label)}
                  className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-4 text-left transition hover:-translate-y-0.5 hover:bg-white/[0.06] disabled:opacity-50"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-emerald-400/12 text-sm font-semibold text-emerald-200">
                    {app.accent}
                  </div>
                  <p className="mt-3 text-sm font-semibold text-aura-text">{app.label}</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">{app.target}</p>
                </button>
              ))}
            </div>
          </Card>

          <Card className="rounded-[30px] px-5 py-5">
            <SectionHeading
              title="Prompt Starters"
              detail="These route into the same conversation model used by text chat and voice chat."
            />
            <div className="mt-4 space-y-3">
              {DESKTOP_EXAMPLES.map((example) => (
                <button
                  key={example}
                  className="w-full rounded-[20px] border border-white/8 bg-white/[0.03] px-4 py-4 text-left transition hover:bg-white/[0.06]"
                  onClick={() => void sendMessage("text", example)}
                >
                  <p className="text-sm font-medium text-aura-text">{example}</p>
                  <p className="mt-1 text-xs leading-5 text-aura-muted">Send this to the managed OpenClaw runtime.</p>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
