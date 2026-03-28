/**
 * Direct Groq LLM client for Aura Desktop.
 *
 * Calls the Groq API (OpenAI-compatible) with streaming SSE,
 * matching the aura-extension's groqClient.ts.
 */

import https from "node:https";
import http from "node:http";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const REQUEST_TIMEOUT_MS = 60_000;

// Pre-bundled Groq key — Aura provides all services out of the box
const MANAGED_GROQ_KEY = "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";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

/**
 * Resolve the Groq API key from available sources.
 */
export function resolveGroqApiKey(configApiKey?: string): string {
  // 1. Env vars (main process sees .env.local via loadEnvFiles)
  const envKey = process.env.GROQ_API_KEY
    || process.env.VITE_LLM_API_KEY
    || process.env.PLASMO_PUBLIC_LLM_API_KEY;
  if (envKey) return envKey;
  // 2. Config file key
  if (configApiKey && configApiKey.startsWith("gsk_") && configApiKey.length > 24) return configApiKey;
  // 3. Pre-bundled managed key
  return MANAGED_GROQ_KEY;
}

/**
 * Stream a chat completion from Groq, emitting tokens as they arrive.
 */
export function streamChat(
  apiKey: string,
  messages: ChatMessage[],
  callbacks: LlmStreamCallbacks,
  options?: { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
): void {
  const model = options?.model ?? DEFAULT_MODEL;
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

          if (res.statusCode === 401) {
            callbacks.onError(new Error(`Groq API key is invalid. ${detail}`));
          } else if (res.statusCode === 429) {
            callbacks.onError(new Error(`Groq rate limit exceeded. Wait a moment and try again. ${detail}`));
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
            // ignore parse errors in SSE chunks
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

/**
 * Non-streaming completion for simple one-shot requests.
 */
export async function completeChat(
  apiKey: string,
  messages: ChatMessage[],
  options?: { model?: string; temperature?: number; maxTokens?: number },
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
