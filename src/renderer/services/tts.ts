/**
 * Text-to-Speech service for Aura Desktop renderer.
 * Ported from aura-extension's tts.ts.
 *
 * - Deepgram TTS (aura-asteria-en) when API key is available
 * - WebSpeech fallback when key is missing or Deepgram fails
 */

function stripMarkdown(text: string): string {
  if (!text) return "";
  return text
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "");
}

function chunkCaptions(text: string, maxWords = 6): string[] {
  const clauses = text.split(/(?<=[.!?…])\s+|(?<=[,;:—–])\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (const clause of clauses) {
    const words = clause.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      chunks.push(words.join(" "));
    } else {
      for (let i = 0; i < words.length; i += maxWords) {
        chunks.push(words.slice(i, i + maxWords).join(" "));
      }
    }
  }
  return chunks.length > 0 ? chunks : [text];
}

const DEFAULT_DEEPGRAM_TTS_MODEL = "aura-2-athena-en";
const FALLBACK_DEEPGRAM_TTS_MODELS = ["aura-2-helena-en", "aura-asteria-en"];

function stripSpeechArtifacts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+\b/gi, " ")
    .replace(/\b\S+@\S+\.\S+\b/gi, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/[:;=8xX]-?[)(DPp/\\|]/g, " ")
    .replace(/\s+-\s+/g, ". ")
    .replace(/\s+\/\s+/g, " or ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s*([,;:.!?])\s*/g, "$1 ")
    .replace(/([!?.,]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function prepareSpeechText(text: string): string {
  const cleaned = stripSpeechArtifacts(stripMarkdown(text)).trim();
  if (!cleaned) {
    return "";
  }

  const normalized = cleaned.length > 900
    ? `${cleaned.slice(0, 900).trimEnd()}...`
    : cleaned;

  return /[.!?…]$/.test(normalized) ? normalized : `${normalized}.`;
}

function chunkSpeechCaptions(text: string, maxWords = 7): string[] {
  const clauses = text.split(/(?<=[.!?…])\s+|(?<=[,;:—–-])\s+/).filter(Boolean);
  const chunks: string[] = [];

  for (const clause of clauses) {
    const words = clause.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      chunks.push(words.join(" "));
      continue;
    }

    for (let i = 0; i < words.length; i += maxWords) {
      chunks.push(words.slice(i, i + maxWords).join(" "));
    }
  }

  return chunks.length > 0 ? chunks : [text];
}

function getPreferredDeepgramModels(): string[] {
  const configuredModel = (import.meta.env.VITE_DEEPGRAM_TTS_MODEL as string | undefined)?.trim();
  return [configuredModel, DEFAULT_DEEPGRAM_TTS_MODEL, ...FALLBACK_DEEPGRAM_TTS_MODELS]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

let currentAudio: HTMLAudioElement | null = null;

/** Stop all speech immediately */
export function stopSpeaking(): void {
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.src = "";
    } catch { /* ignore */ }
    currentAudio = null;
  }
}

/**
 * Speak text with optional caption chunks synced to audio.
 */
export async function speakStreaming(
  text: string,
  key: string | undefined,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  onFallback?: (reason: string) => void,
): Promise<void> {
  if (!text.trim()) return;

  const safe = prepareSpeechText(text);
  if (!safe) return;

  const chunks = chunkSpeechCaptions(safe, 7);

  if (signal?.aborted) return;

  if (key) {
    try {
      await speakDeepgram(safe, key, chunks, onChunk, signal);
      return;
    } catch (err) {
      if (signal?.aborted) return;
      const reason = err instanceof Error ? err.message : "Unknown TTS error";
      console.warn("[Aura TTS] Deepgram failed:", reason);
      onFallback?.(reason);
      stopSpeaking();
    }
  }

  if (signal?.aborted) return;
  await speakWithWebSpeech(safe, signal, chunks, onChunk);
}

/** Resolve the pre-bundled Deepgram key from env */
export function resolveDeepgramKey(): string | undefined {
  return (import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined)
    || (import.meta.env.PLASMO_PUBLIC_DEEPGRAM_API_KEY as string | undefined)
    || undefined;
}

/** Simple one-shot speak */
export async function speak(text: string, deepgramKey?: string): Promise<void> {
  return speakStreaming(text, deepgramKey ?? resolveDeepgramKey(), () => {});
}

// --- Deepgram TTS ---

async function fetchDeepgramAudio(
  text: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Blob> {
  let lastError: Error | null = null;

  for (const model of getPreferredDeepgramModels()) {
    const response = await fetch(
      `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`,
      {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      },
    );

    if (response.ok) {
      return response.blob();
    }

    const body = await response.text().catch(() => "");
    lastError = new Error(`Deepgram TTS ${response.status}: ${body.slice(0, 160)}`);

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw lastError;
    }
  }

  throw lastError ?? new Error("Deepgram TTS failed.");
}

async function speakDeepgram(
  text: string,
  apiKey: string,
  chunks: string[],
  onChunk: (c: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const blob = await fetchDeepgramAudio(text, apiKey, signal);
  const url = URL.createObjectURL(blob);

  return new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    audio.playbackRate = 1;
    currentAudio = audio;

    let settled = false;
    let lastChunkIdx = -1;
    const advanceCaption = () => {
      if (!audio.duration || chunks.length === 0) return;
      const idx = Math.min(Math.floor((audio.currentTime / audio.duration) * chunks.length), chunks.length - 1);
      if (idx !== lastChunkIdx) { lastChunkIdx = idx; onChunk(chunks[idx]!); }
    };

    audio.onplay = () => { if (chunks[0]) { onChunk(chunks[0]); lastChunkIdx = 0; } };
    audio.ontimeupdate = advanceCaption;

    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      try { audio.pause(); audio.src = ""; } catch { /* ignore */ }
      URL.revokeObjectURL(url);
      currentAudio = null;
      if (err) reject(err);
      else resolve();
    };

    audio.onended = () => cleanup();
    audio.onerror = () => cleanup(new Error("Audio playback failed"));

    if (signal) {
      signal.addEventListener("abort", () => cleanup(), { once: true });
    }
    if (signal?.aborted) { cleanup(); return; }

    audio.play().catch((e: Error) => cleanup(e));
  });
}

// --- WebSpeech fallback ---

function speakWithWebSpeech(
  text: string,
  signal?: AbortSignal,
  chunks?: string[],
  onChunk?: (c: string) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }

    const trySpeak = () => {
      if (signal?.aborted) { resolve(); return; }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.98;
      utterance.pitch = 1.02;
      utterance.volume = 1.0;
      utterance.lang = "en-US";

      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(
        (v) => v.lang.startsWith("en") && /Aria|Jenny|Neural|Natural|Samantha|Google|Microsoft/i.test(v.name),
      ) ?? voices.find((v) => v.lang.startsWith("en"));
      if (preferred) utterance.voice = preferred;

      if (chunks && chunks.length > 0 && onChunk) {
        let wordCount = 0;
        let currentChunkIdx = 0;
        const chunkEndWords: number[] = [];
        let cumulative = 0;
        for (const chunk of chunks) {
          cumulative += chunk.split(/\s+/).filter(Boolean).length;
          chunkEndWords.push(cumulative);
        }
        onChunk(chunks[0]!);
        utterance.onboundary = (e) => {
          if (e.name !== "word") return;
          wordCount++;
          const nextIdx = chunkEndWords.findIndex((end) => wordCount < end);
          const idx = nextIdx >= 0 ? nextIdx : chunks.length - 1;
          if (idx !== currentChunkIdx) {
            currentChunkIdx = idx;
            onChunk(chunks[idx]!);
          }
        };
      }

      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      signal?.addEventListener("abort", () => {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
        resolve();
      }, { once: true });

      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    };

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) { trySpeak(); } else {
      window.speechSynthesis.onvoiceschanged = () => trySpeak();
      setTimeout(trySpeak, 800);
    }
  });
}
