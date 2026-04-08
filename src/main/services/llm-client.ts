/**
 * Multi-provider LLM client for Aura Desktop.
 *
 * Primary: Google Gemini (generativelanguage.googleapis.com)
 * Fallback: Groq (api.groq.com, OpenAI-compatible)
 *
 * Both support streaming SSE. The auto-router picks the best available provider.
 */

import https from "node:https";
import http from "node:http";

// ── Constants ──────────────────────────────────────────────────────────────

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DEFAULT_MODEL = "gemini-2.0-flash";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
const GROQ_FALLBACK_MODEL = "llama-3.1-8b-instant";

const REQUEST_TIMEOUT_MS = 60_000;

// Pre-bundled Groq key — Aura provides all services out of the box
const MANAGED_GROQ_KEY = "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";

// ── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

export type LlmProvider = "gemini" | "groq";

// ── Key resolution ─────────────────────────────────────────────────────────

export function resolveGeminiApiKey(configApiKey?: string): string | null {
  const envKey = process.env.GOOGLE_API_KEY;
  if (envKey) return envKey;
  if (configApiKey && configApiKey.startsWith("AIza") && configApiKey.length > 20) return configApiKey;
  return null;
}

export function resolveGroqApiKey(configApiKey?: string): string {
  const envKey = process.env.GROQ_API_KEY
    || process.env.VITE_LLM_API_KEY;
  if (envKey) return envKey;
  if (configApiKey && configApiKey.startsWith("gsk_") && configApiKey.length > 24) return configApiKey;
  return MANAGED_GROQ_KEY;
}

/**
 * Resolve the best available provider and API key.
 * Returns { provider, apiKey } - prefers Gemini when a Gemini key is available.
 */
export function resolveProvider(geminiConfigKey?: string, groqConfigKey?: string): { provider: LlmProvider; apiKey: string } {
  const geminiKey = resolveGeminiApiKey(geminiConfigKey);
  if (geminiKey) return { provider: "gemini", apiKey: geminiKey };
  const groqKey = resolveGroqApiKey(groqConfigKey);
  return { provider: "groq", apiKey: groqKey };
}

// ── Gemini streaming ───────────────────────────────────────────────────────

function convertToGeminiMessages(messages: ChatMessage[]): { systemInstruction?: { parts: { text: string }[] }; contents: Array<{ role: string; parts: { text: string }[] }> } {
  let systemText = "";
  const contents: Array<{ role: string; parts: { text: string }[] }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemText += (systemText ? "\n" : "") + msg.content;
    } else {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }
  }

  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
  };
}

export function streamChatGemini(
  apiKey: string,
  messages: ChatMessage[],
  callbacks: LlmStreamCallbacks,
  options?: { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
): void {
  const model = options?.model ?? GEMINI_DEFAULT_MODEL;
  const geminiMessages = convertToGeminiMessages(messages);
  const body = JSON.stringify({
    ...geminiMessages,
    generationConfig: {
      temperature: options?.temperature ?? 0.2,
      maxOutputTokens: options?.maxTokens ?? 4096,
    },
  });

  const url = new URL(`${GEMINI_BASE}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`);

  const req = https.request(
    {
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (res) => {
      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", (chunk) => { errBody += chunk.toString(); });
        res.on("end", () => {
          let detail = "";
          try {
            const parsed = JSON.parse(errBody) as { error?: { message?: string } };
            detail = parsed?.error?.message ?? errBody.slice(0, 300);
          } catch {
            detail = errBody.slice(0, 300);
          }
          callbacks.onError(new Error(`Gemini request failed (${res.statusCode}): ${detail}`));
        });
        return;
      }

      let buffer = "";
      let fullText = "";
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        callbacks.onDone(fullText);
      };

      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") { finish(); continue; }

          try {
            const payload = JSON.parse(jsonStr) as {
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
                finishReason?: string;
              }>;
            };
            const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              fullText += text;
              callbacks.onToken(text);
            }
            if (payload.candidates?.[0]?.finishReason === "STOP") finish();
          } catch {
            // ignore parse errors in SSE
          }
        }
      });

      res.on("end", () => {
        if (fullText && !done) finish();
      });

      res.on("error", (err) => {
        callbacks.onError(err);
      });
    },
  );

  req.on("error", (err) => {
    callbacks.onError(err);
  });

  req.on("timeout", () => {
    req.destroy(new Error("Gemini API request timed out."));
  });

  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      req.destroy(new Error("Request aborted."));
    }, { once: true });
  }

  req.write(body);
  req.end();
}

// ── Groq streaming (OpenAI-compatible) ─────────────────────────────────────

export function streamChatGroq(
  apiKey: string,
  messages: ChatMessage[],
  callbacks: LlmStreamCallbacks,
  options?: { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
): void {
  const model = options?.model ?? GROQ_DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    messages,
    temperature: options?.temperature ?? 0.2,
    max_tokens: options?.maxTokens ?? 4096,
    stream: true,
  });

  const url = new URL(`${GROQ_BASE_URL}/chat/completions`);
  const isHttps = url.protocol === "https:";

  const req = (isHttps ? https : http).request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (res) => {
      if (res.statusCode !== 200) {
        let errBody = "";
        res.on("data", (chunk) => { errBody += chunk.toString(); });
        res.on("end", () => {
          let detail = "";
          try {
            const parsed = JSON.parse(errBody) as { error?: { message?: string } };
            detail = parsed?.error?.message ?? errBody.slice(0, 200);
          } catch {
            detail = errBody.slice(0, 200);
          }

          if (res.statusCode === 429) {
            const currentModel = options?.model ?? GROQ_DEFAULT_MODEL;
            if (currentModel !== GROQ_FALLBACK_MODEL) {
              console.warn(`[LLM] Rate limited on ${currentModel} — retrying with ${GROQ_FALLBACK_MODEL}`);
              streamChatGroq(apiKey, messages, callbacks, { ...options, model: GROQ_FALLBACK_MODEL });
            } else {
              callbacks.onError(new Error(`Groq rate limit exceeded on all models. ${detail}`));
            }
          } else {
            callbacks.onError(new Error(`Groq request failed (${res.statusCode}): ${detail}`));
          }
        });
        return;
      }

      let buffer = "";
      let fullText = "";
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        callbacks.onDone(fullText);
      };

      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") {
            if (trimmed === "data: [DONE]") finish();
            continue;
          }

          try {
            const payload = JSON.parse(trimmed.slice(6)) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            };
            const token = payload.choices?.[0]?.delta?.content;
            if (token) {
              fullText += token;
              callbacks.onToken(token);
            }
            if (payload.choices?.[0]?.finish_reason === "stop") finish();
          } catch {
            // ignore parse errors in SSE
          }
        }
      });

      res.on("end", () => {
        if (fullText) finish();
      });

      res.on("error", (err) => {
        callbacks.onError(err);
      });
    },
  );

  req.on("error", (err) => {
    callbacks.onError(err);
  });

  req.on("timeout", () => {
    req.destroy(new Error("Groq API request timed out."));
  });

  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      req.destroy(new Error("Request aborted."));
    }, { once: true });
  }

  req.write(body);
  req.end();
}

// ── Auto-routing streamer ──────────────────────────────────────────────────

/**
 * Stream chat using the best available provider (Gemini first, Groq fallback).
 * This is the main entry point for all direct LLM calls.
 */
export function streamChat(
  apiKey: string,
  messages: ChatMessage[],
  callbacks: LlmStreamCallbacks,
  options?: { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal; provider?: LlmProvider },
): void {
  const provider = options?.provider;
  if (provider === "groq") {
    return streamChatGroq(apiKey, messages, callbacks, options);
  }
  if (provider === "gemini") {
    return streamChatGemini(apiKey, messages, callbacks, options);
  }

  // Auto-detect: if the key looks like a Gemini key, use Gemini
  if (apiKey.startsWith("AIza")) {
    console.log("[LLM] Auto-detected Gemini key — using Gemini provider");
    return streamChatGemini(apiKey, messages, callbacks, options);
  }

  // Default to Groq
  return streamChatGroq(apiKey, messages, callbacks, options);
}

// ── Non-streaming completion ───────────────────────────────────────────────

/**
 * Non-streaming completion for simple one-shot requests.
 */
export async function completeChat(
  apiKey: string,
  messages: ChatMessage[],
  options?: { model?: string; temperature?: number; maxTokens?: number; provider?: LlmProvider },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let result = "";
    let resolved = false;
    streamChat(apiKey, messages, {
      onToken: (token) => { result += token; },
      onDone: (text) => {
        if (!resolved) {
          resolved = true;
          resolve(text || result);
        }
      },
      onError: (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      },
    }, options);
  });
}
