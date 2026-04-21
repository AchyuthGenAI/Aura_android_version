import { useCallback, useEffect, useRef, useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";
import { DeepgramClient } from "@renderer/services/deepgram";
import { WebSpeechClient } from "@renderer/services/web-speech";
import { speakStreaming, stopSpeaking } from "@renderer/services/tts";
import { AuraFace } from "./AuraFace";

import type { ChatSendResult, TaskProgressPayload, TaskErrorPayload } from "@shared/types";

type VoiceClient = DeepgramClient | WebSpeechClient;
type Phase = "idle" | "listening" | "thinking" | "task" | "speaking";

// ── Mic level visualizer ────────────────────────────────────────────────────

function MicLevelBars({ stream }: { stream: MediaStream | null }): JSX.Element {
  const [levels, setLevels] = useState([0.1, 0.1, 0.1, 0.1, 0.1]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!stream) {
      setLevels([0.1, 0.1, 0.1, 0.1, 0.1]);
      return;
    }
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.7;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(data);
        const bands = [2, 4, 8, 14, 20].map((i) => Math.min(1, (data[i] ?? 0) / 200));
        setLevels(bands);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch { /* AudioContext unavailable */ }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try { ctxRef.current?.close(); } catch { /* ignore */ }
      ctxRef.current = null;
      analyserRef.current = null;
    };
  }, [stream]);

  return (
    <div className="flex items-end justify-center gap-[3px] h-8">
      {levels.map((level, i) => (
        <div
          key={i}
          className="w-1.5 rounded-full bg-[#ec4899] transition-all duration-75"
          style={{ height: `${Math.max(8, level * 32)}px`, opacity: 0.5 + level * 0.5 }}
        />
      ))}
    </div>
  );
}

// ── VoicePanel ──────────────────────────────────────────────────────────────

export const VoicePanel = ({ active }: { active: boolean }): JSX.Element => {
  const sendMessage = useAuraStore((s) => s.sendMessage);
  const stopMessage = useAuraStore((s) => s.stopMessage);
  const settings = useAuraStore((s) => s.settings);
  const pushToast = useAuraStore((s) => s.pushToast);

  const [phase, setPhase] = useState<Phase>("idle");
  const [caption, setCaption] = useState("");
  const [captionKey, setCaptionKey] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [notice, setNotice] = useState("");

  // Refs for stable closures
  const phaseRef = useRef<Phase>("idle");
  const inVoiceModeRef = useRef(false);
  const clientRef = useRef<VoiceClient | null>(null);
  const lastTranscriptRef = useRef("");
  const waitingForRef = useRef(false);
  const playbackIdRef = useRef(0);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const isActiveRef = useRef(active);
  const sttErrorBurstRef = useRef({ count: 0, at: 0 });

  // Pre-bundled Deepgram key
  const deepgramKey = settings.deepgramKey
    || (import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined)
    || undefined;
  const dgKeyRef = useRef(deepgramKey);
  useEffect(() => { dgKeyRef.current = deepgramKey; }, [deepgramKey]);

  const transitionPhase = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  useEffect(() => { isActiveRef.current = active; }, [active]);

  const showVoiceToast = useCallback((
    tone: "info" | "success" | "warning" | "error",
    title: string,
    message?: string,
  ) => {
    pushToast(tone, title, message);
  }, [pushToast]);

  // ── Stop helpers ────────────────────────────────────────────────────────

  const stopSpeakingNow = useCallback(() => {
    stopSpeaking();
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
  }, []);

  const stopClient = useCallback(async (): Promise<string> => {
    const c = clientRef.current;
    clientRef.current = null;
    setMicStream(null);
    if (!c) return "";
    if (c instanceof DeepgramClient) return await c.stop();
    return c.stop();
  }, []);

  const scheduleResumeListening = useCallback((delayMs = 800) => {
    window.setTimeout(() => {
      if (inVoiceModeRef.current && isActiveRef.current) {
        void startListeningCycleRef.current();
      } else {
        transitionPhase("idle");
      }
    }, delayMs);
  }, []);

  const speakAssistantText = useCallback(async (text: string) => {
    const normalized = text.trim();
    if (!normalized) {
      scheduleResumeListening(500);
      return;
    }

    waitingForRef.current = false;
    const currentId = ++playbackIdRef.current;
    transitionPhase("speaking");
    setTaskStatus("");
    setNotice("");

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;

    try {
      await speakStreaming(
        normalized,
        dgKeyRef.current,
        (chunk) => {
          if (playbackIdRef.current === currentId) {
            setCaption(chunk);
            setCaptionKey((k) => k + 1);
          }
        },
        ctrl.signal,
      );
    } catch {
      // interrupted
    }

    abortCtrlRef.current = null;
    if (playbackIdRef.current !== currentId) return;

    setCaption("");
    scheduleResumeListening(250);
  }, [scheduleResumeListening]);

  const handleSendOutcome = useCallback(async (result: ChatSendResult | null) => {
    if (!result || !waitingForRef.current) return;

    if (result.status === "done" && result.resultText) {
      await speakAssistantText(result.resultText);
      return;
    }

    if (result.status === "error" || result.status === "cancelled") {
      waitingForRef.current = false;
      setTaskStatus("");
      const nextNotice = result.errorText || (result.status === "cancelled" ? "Request cancelled." : "Request failed.");
      setNotice(nextNotice);
      showVoiceToast(
        result.status === "cancelled" ? "warning" : "error",
        result.status === "cancelled" ? "Voice request cancelled" : "Voice request failed",
        nextNotice,
      );
      scheduleResumeListening(1000);
    }
  }, [scheduleResumeListening, showVoiceToast, speakAssistantText]);

  const recordSttError = useCallback((message: string): number => {
    const timestamp = Date.now();
    const burst = sttErrorBurstRef.current;
    if (timestamp - burst.at <= 10_000) {
      burst.count += 1;
    } else {
      burst.count = 1;
    }
    burst.at = timestamp;
    if (/permission|microphone|denied|not found/i.test(message)) {
      burst.count = 3;
    }
    return burst.count;
  }, []);

  // ── Submit voice command ────────────────────────────────────────────────

  const submitCommand = useCallback(async (command: string) => {
    if (!command.trim()) {
      const nextNotice = "I didn't catch that. Please try again.";
      setNotice(nextNotice);
      showVoiceToast("info", "Voice input needed", nextNotice);
      scheduleResumeListening(450);
      return;
    }

    transitionPhase("thinking");
    setCaption("");
    setTranscript("");
    setTaskStatus("");
    waitingForRef.current = true;

    try {
      const result = await sendMessage("voice", command);
      await handleSendOutcome(result);
    } catch (error) {
      waitingForRef.current = false;
      const nextNotice = error instanceof Error ? error.message : "Voice request failed.";
      setNotice(nextNotice);
      showVoiceToast("error", "Voice request failed", nextNotice);
      scheduleResumeListening(800);
    }
  }, [handleSendOutcome, scheduleResumeListening, sendMessage, showVoiceToast]);

  // ── Start listening cycle ───────────────────────────────────────────────

  const startListeningCycle = useCallback(async () => {
    if (!inVoiceModeRef.current) { transitionPhase("idle"); return; }

    await stopClient();
    setCaption("");
    setTranscript("");
    setTaskStatus("");
    setNotice("");
    lastTranscriptRef.current = "";
    transitionPhase("listening");

    const onSilenceDetected = () => {
      void (async () => {
        const text = await stopClient();
        const command = text.trim() || lastTranscriptRef.current.trim();
        await submitCommand(command);
      })();
    };

    const callbacks = {
      onInterimTranscript: (t: string) => { setTranscript(t); lastTranscriptRef.current = t; },
      onFinalTranscript: (t: string) => { setTranscript(t); lastTranscriptRef.current = t; },
      onSilenceDetected,
      onError: (e: Error) => {
        console.warn("[VoicePanel] Voice error:", e.message);
        setNotice(e.message);
        showVoiceToast("warning", "Voice input issue", e.message);
        setMicStream(null);
        const burstCount = recordSttError(e.message);
        if (burstCount >= 3) {
          inVoiceModeRef.current = false;
          transitionPhase("idle");
          const pausedNotice = `${e.message} Voice mode paused.`;
          setNotice(pausedNotice);
          showVoiceToast("error", "Voice mode paused", pausedNotice);
          return;
        }
        scheduleResumeListening(1200);
      },
    };

    // Try Deepgram
    try {
      const key = dgKeyRef.current;
      if (key) {
        const client = new DeepgramClient(key, callbacks);
        await client.start();
        clientRef.current = client;
        setMicStream(client.micStream);
        return;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn("[VoicePanel] Deepgram failed, using browser speech:", reason);
      const nextNotice = `Deepgram failed: ${reason}. Trying browser speech recognition.`;
      setNotice(nextNotice);
      showVoiceToast("warning", "Deepgram unavailable", "Aura switched to browser speech recognition for now.");
    }

    // WebSpeech fallback
    const client = new WebSpeechClient(callbacks);
    if (!client.isSupported()) {
      const nextNotice = "Voice transcription is unavailable. Check microphone access and Deepgram configuration.";
      setNotice(nextNotice);
      showVoiceToast("error", "Voice unavailable", nextNotice);
      transitionPhase("idle");
      inVoiceModeRef.current = false;
      return;
    }
    await client.start();
    clientRef.current = client;
    setMicStream(null);
  }, [recordSttError, scheduleResumeListening, showVoiceToast, stopClient, submitCommand]);

  const startListeningCycleRef = useRef(startListeningCycle);
  useEffect(() => { startListeningCycleRef.current = startListeningCycle; }, [startListeningCycle]);

  // ── Listen for LLM_DONE, TASK_PROGRESS, TASK_ERROR from IPC ────────────

  useEffect(() => {
    const listener = (msg: { type?: string; payload?: unknown }) => {
      if (msg.type === "TASK_PROGRESS") {
        const p = msg.payload as TaskProgressPayload;
        if (phaseRef.current === "thinking" || phaseRef.current === "task") {
          transitionPhase("task");
          const runningStep = p.task?.steps?.find((s) => s.status === "running");
          setTaskStatus(runningStep?.tool ? `${runningStep.tool.replace(/_/g, " ")}...` : "Working...");
        }
        return;
      }

      if (msg.type === "TASK_ERROR") {
        if (!waitingForRef.current) return;
        waitingForRef.current = false;
        const p = msg.payload as TaskErrorPayload;
        setTaskStatus("");
        console.warn("[VoicePanel] Task error:", p.message);
        setNotice(p.message);
        showVoiceToast("error", "Voice task failed", p.message);
        scheduleResumeListening(900);
        return;
      }

      if (msg.type === "LLM_DONE") {
        const p = msg.payload as { fullText: string; cleanText?: string };
        const text = (p.cleanText || p.fullText || "").trim();

        if (text && waitingForRef.current) {
          void speakAssistantText(text);
        } else if (waitingForRef.current) {
          waitingForRef.current = false;
          setTaskStatus("");
          scheduleResumeListening(500);
        }
      }
    };

    const unsubscribe = window.auraDesktop.onAppEvent(listener);
    return unsubscribe;
  }, [scheduleResumeListening, showVoiceToast, speakAssistantText]);

  // ── Pause/resume on tab visibility ──────────────────────────────────────

  useEffect(() => {
    if (!active) {
      playbackIdRef.current++;
      void stopClient();
      stopSpeakingNow();
      if (phaseRef.current !== "idle") transitionPhase("idle");
      setMicStream(null);
    } else if (inVoiceModeRef.current) {
      void startListeningCycleRef.current();
    }
  }, [active, stopClient, stopSpeakingNow]);

  // ── Interrupt and return to listening ───────────────────────────────────

  const interruptAndListen = useCallback(async () => {
    stopSpeakingNow();
    void stopMessage();
    playbackIdRef.current++;
    waitingForRef.current = false;
    setTaskStatus("");
    if (inVoiceModeRef.current && isActiveRef.current) {
      await startListeningCycleRef.current();
    } else {
      transitionPhase("idle");
    }
  }, [stopSpeakingNow, stopMessage]);

  // ── Enter / Exit voice mode ─────────────────────────────────────────────

  const enterVoiceMode = useCallback(async () => {
    inVoiceModeRef.current = true;
    await startListeningCycleRef.current();
  }, []);

  const exitVoiceMode = useCallback(async () => {
    inVoiceModeRef.current = false;
    stopSpeakingNow();
    playbackIdRef.current++;
    await stopClient();
    transitionPhase("idle");
    setCaption("");
    setTranscript("");
    setTaskStatus("");
    setNotice("");
    setMicStream(null);
  }, [stopSpeakingNow, stopClient]);

  const handleMicTap = useCallback(async () => {
    if (!inVoiceModeRef.current) await enterVoiceMode();
    else await exitVoiceMode();
  }, [enterVoiceMode, exitVoiceMode]);

  // ── Cleanup on unmount ──────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      inVoiceModeRef.current = false;
      stopSpeakingNow();
      playbackIdRef.current++;
      void stopClient();
    };
  }, [stopSpeakingNow, stopClient]);

  // ── Render ──────────────────────────────────────────────────────────────

  const faceState = (phase === "thinking" || phase === "task") ? "idle" : phase === "speaking" ? "speaking" : phase;

  return (
    <div className="relative flex h-full w-full flex-col items-center">

      {/* AuraFace blob */}
      <div className="absolute inset-x-0 top-0 bottom-[160px] flex items-center justify-center">
        <AuraFace state={faceState} />
      </div>

      {/* Caption / Transcript area */}
      <div className="absolute left-4 right-4 bottom-[96px] z-20 flex max-h-[160px] flex-col justify-end">
        <div className="flex flex-col items-center justify-end overflow-y-auto pb-2">

          {/* Listening — mic level bars + live transcript */}
          {phase === "listening" && (
            <div className="flex flex-col items-center gap-2 w-full">
              <MicLevelBars stream={micStream} />
              {transcript ? (
                <p
                  className="text-lg font-medium leading-relaxed text-white/90 text-center"
                  style={{ textShadow: "0 0 20px rgba(236,72,153,0.3), 0 2px 4px rgba(0,0,0,0.9)" }}
                >
                  {transcript.split(/\s+/).slice(-7).join(" ")}
                </p>
              ) : (
                <p className="text-center text-[11px] font-semibold text-[#ec4899]/60 tracking-wide animate-pulse">
                  Listening...
                </p>
              )}
              {notice && (
                <p className="max-w-[260px] text-center text-[10px] font-medium text-amber-200/80">
                  {notice}
                </p>
              )}
            </div>
          )}

          {/* Thinking */}
          {phase === "thinking" && (
            <div className="flex flex-col items-center gap-2 py-3">
              <div className="h-1 w-20 rounded-full bg-gradient-to-r from-[#a855f7] via-[#06b6d4] to-[#a855f7] bg-[length:200%_100%] animate-shimmer shadow-[0_0_12px_rgba(34,211,238,0.4)]" />
              <p className="text-[9px] font-bold uppercase tracking-widest text-[#06b6d4]/80">Thinking...</p>
            </div>
          )}

          {/* Task executing */}
          {phase === "task" && (
            <div className="flex flex-col items-center gap-2 py-3 w-full">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-[#a855f7]" />
                <p className="text-[9px] font-bold uppercase tracking-widest text-[#a855f7]/80">Executing task</p>
              </div>
              {taskStatus && (
                <p className="text-center text-[11px] text-aura-muted/70 capitalize">{taskStatus}</p>
              )}
            </div>
          )}

          {/* Speaking — captions */}
          {phase === "speaking" && caption && (
            <div className="w-full px-2 text-center">
              <p
                key={captionKey}
                className="text-lg font-semibold leading-relaxed text-white caption-fade-in"
                style={{ textShadow: "0 0 20px rgba(6,182,212,0.3), 0 2px 4px rgba(0,0,0,0.9)" }}
              >
                {caption}
              </p>
            </div>
          )}

          {/* Idle hint */}
          {phase === "idle" && (
            <div className="flex flex-col items-center gap-1.5 px-4 py-2">
              <p className="text-center text-sm font-semibold text-aura-text/70">Voice Mode</p>
              <p className="text-center text-[11px] text-aura-muted/60">
                Tap the mic to talk to Aura hands-free
              </p>
              {notice && (
                <p className="max-w-[280px] text-center text-[10px] font-medium text-amber-200/80">
                  {notice}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="absolute bottom-4 left-0 right-0 z-30 flex flex-col items-center gap-2">

        {/* Mic button */}
        <button
          type="button"
          onClick={() => void (
            phase === "thinking" || phase === "speaking" || phase === "task"
              ? interruptAndListen()
              : handleMicTap()
          )}
          className={`group relative inline-flex h-14 w-14 items-center justify-center rounded-full transition-all duration-300
            ${phase === "listening"
              ? "scale-105 bg-[#ec4899] shadow-lg shadow-[#ec4899]/40"
              : phase === "task"
              ? "bg-[#a855f7]/60 shadow-lg shadow-[#a855f7]/30 hover:scale-105 active:scale-95"
              : phase === "thinking" || phase === "speaking"
              ? "bg-[#a855f7]/80 shadow-lg shadow-[#a855f7]/40 hover:scale-105 active:scale-95"
              : "bg-gradient-to-br from-[#a855f7] to-[#ec4899] shadow-lg shadow-[#a855f7]/30 hover:scale-105 active:scale-95"
            }`}
        >
          {phase === "listening" && (
            <span className="absolute inset-0 animate-pulse rounded-full bg-[#ec4899]/20" />
          )}
          {phase === "task" && (
            <span className="absolute inset-0 animate-ping rounded-full bg-[#a855f7]/10" />
          )}
          <span className="relative flex items-center justify-center text-white">
            {phase === "listening" ? (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            )}
          </span>
        </button>

        <p className="text-[10px] text-aura-muted/50">
          {phase === "idle" && "Tap to start"}
          {phase === "listening" && "Tap to stop"}
          {(phase === "thinking" || phase === "speaking" || phase === "task") && "Tap to interrupt"}
        </p>
      </div>
    </div>
  );
};
