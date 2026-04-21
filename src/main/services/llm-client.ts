import http from "node:http";
import https from "node:https";

import type { OpenClawConfig } from "@shared/types";

const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;
const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 20_000;
const RATE_LIMIT_JITTER_MS = 250;

const OPENAI_COMPATIBLE_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  // Groq exposes an OpenAI-compatible REST API at /openai/v1, so we can
  // reuse the same streamOpenAiCompatible transport without a bespoke client.
  groq: "https://api.groq.com/openai/v1",
} as const;

const DEFAULT_MODELS = {
  openai: {
    chat: "gpt-4o-mini",
    fast: "gpt-4o-mini",
  },
  openrouter: {
    chat: "openai/gpt-4o-mini",
    fast: "openai/gpt-4o-mini",
  },
  google: {
    chat: "gemini-2.0-flash",
    fast: "gemini-2.0-flash",
  },
  anthropic: {
    chat: "claude-3-5-haiku-latest",
    fast: "claude-3-5-haiku-latest",
  },
  groq: {
    chat: "llama-3.3-70b-versatile",
    fast: "llama-3.1-8b-instant",
  },
} as const;

// Groq is listed first because it has the most generous free-tier quota and
// is the primary provider Aura ships preconfigured with. If the Groq key is
// missing or rate-limited we fall through to Google Gemini, then the rest.
const DIRECT_PROVIDER_FALLBACK_ORDER = ["groq", "google", "openai", "openrouter", "anthropic"] as const;

export interface LlmToolParam {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string; enum?: string[] };
}

export interface LlmTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, LlmToolParam>;
    required?: string[];
  };
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = 
  | {
      role: "system" | "user" | "assistant";
      content: string | ChatContentPart[] | null;
      tool_calls?: LlmToolCall[];
    }
  | {
      role: "tool";
      content: string | ChatContentPart[];
      tool_call_id: string;
    };

export type LlmPurpose = "chat" | "fast";
export type DirectLlmProvider = "openai" | "openrouter" | "google" | "anthropic" | "groq";
export type LlmProviderPreference = DirectLlmProvider | "openclaw" | "auto";

export interface LlmStreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

export interface ResolvedLlmConfig {
  provider: DirectLlmProvider;
  apiKey: string;
  model: string;
  purpose: LlmPurpose;
  source: "managed" | "env" | "config" | "fallback";
  baseUrl?: string;
}

interface LlmRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: LlmTool[];
}

export interface LlmCompletion {
  text: string;
  toolCalls?: LlmToolCall[];
}

interface ProviderKeyResolution {
  apiKey: string;
  source: ResolvedLlmConfig["source"];
}

type ProviderErrorKind = "rate_limit" | "auth" | "quota" | "network" | "timeout" | "unknown";

class ProviderRequestError extends Error {
  readonly provider: DirectLlmProvider;
  readonly kind: ProviderErrorKind;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(options: {
    provider: DirectLlmProvider;
    kind: ProviderErrorKind;
    message: string;
    statusCode?: number;
    retryAfterMs?: number;
  }) {
    super(options.message);
    this.name = "ProviderRequestError";
    this.provider = options.provider;
    this.kind = options.kind;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const providerRateLimitCooldowns = new Map<DirectLlmProvider, { until: number; reason: string }>();

const isOpenAiCompatible = (
  provider: DirectLlmProvider,
): provider is "openai" | "openrouter" | "groq" =>
  provider === "openai" || provider === "openrouter" || provider === "groq";

const defaultModelFor = (provider: DirectLlmProvider, purpose: LlmPurpose): string =>
  DEFAULT_MODELS[provider][purpose];

const normalizeProviderPreference = (value: string | undefined): LlmProviderPreference => {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "openai"
    || normalized === "openrouter"
    || normalized === "google"
    || normalized === "anthropic"
    || normalized === "groq"
    || normalized === "openclaw"
  ) {
    return normalized;
  }
  return "auto";
};

const getEnvKeysForProvider = (provider: DirectLlmProvider): string[] => {
  switch (provider) {
    case "openai":
      return ["OPENAI_API_KEY"];
    case "openrouter":
      return ["OPENROUTER_API_KEY"];
    case "google":
      return ["GOOGLE_API_KEY", "GEMINI_API_KEY", "VITE_GEMINI_API_KEY", "VITE_LLM_API_KEY", "PLASMO_PUBLIC_LLM_API_KEY"];
    case "anthropic":
      return ["ANTHROPIC_API_KEY"];
    case "groq":
      return ["GROQ_API_KEY", "VITE_GROQ_API_KEY"];
    default:
      return [];
  }
};

const resolveConfiguredProviderApiKey = (
  provider: DirectLlmProvider,
  config?: OpenClawConfig,
): ProviderKeyResolution | null => {
  for (const envKey of getEnvKeysForProvider(provider)) {
    const envValue = process.env[envKey];
    if (typeof envValue === "string" && envValue.trim()) {
      return { apiKey: envValue.trim(), source: "env" };
    }
  }

  const configValue = config?.providers?.[provider]?.apiKey;
  if (typeof configValue === "string" && configValue.trim()) {
    return { apiKey: configValue.trim(), source: "config" };
  }

  return null;
};

const resolveProviderApiKey = (
  provider: DirectLlmProvider,
  config?: OpenClawConfig,
): ProviderKeyResolution | null => {
  const configured = resolveConfiguredProviderApiKey(provider, config);
  if (configured) return configured;

  return null;
};

const resolveProviderFromPreference = (config?: OpenClawConfig): DirectLlmProvider => {
  const preferred = normalizeProviderPreference(config?.agents?.main?.provider);
  if (preferred !== "auto" && preferred !== "openclaw") {
    return preferred;
  }

  for (const provider of DIRECT_PROVIDER_FALLBACK_ORDER) {
    if (resolveConfiguredProviderApiKey(provider, config)) {
      return provider;
    }
  }

  return "google";
};

const resolveModelForProvider = (
  provider: DirectLlmProvider,
  purpose: LlmPurpose,
  config?: OpenClawConfig,
  explicitModel?: string,
): string => {
  const overrideModel = explicitModel?.trim();
  if (overrideModel) return overrideModel;

  const configuredProvider = normalizeProviderPreference(config?.agents?.main?.provider);
  const configuredModel = config?.agents?.main?.model?.trim();
  if (configuredModel && configuredProvider === provider) {
    return configuredModel;
  }

  return defaultModelFor(provider, purpose);
};

export function resolveDirectLlmConfig(
  config?: OpenClawConfig,
  purpose: LlmPurpose = "chat",
  explicitModel?: string,
): ResolvedLlmConfig {
  const provider = resolveProviderFromPreference(config);
  const key = resolveProviderApiKey(provider, config);
  if (!key) {
    throw new Error(`No API key configured for ${provider}. Add one in Settings or set the matching environment variable.`);
  }

  return {
    provider,
    apiKey: key.apiKey,
    source: key.source,
    purpose,
    model: resolveModelForProvider(provider, purpose, config, explicitModel),
    baseUrl: isOpenAiCompatible(provider) ? OPENAI_COMPATIBLE_BASE_URLS[provider] : undefined,
  };
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof ProviderRequestError) {
    return error.kind === "rate_limit" || error.kind === "quota";
  }
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("(429)") || msg.includes("rate limit") || msg.includes("resource exhausted");
}

function getRetryPolicy(purpose: LlmPurpose): {
  maxRetries: number;
  baseDelayMs: number;
  maxInteractiveDelayMs: number;
  fallbackCooldownMs: number;
} {
  if (purpose === "fast") {
    return {
      maxRetries: 1,
      baseDelayMs: 750,
      maxInteractiveDelayMs: 2_000,
      fallbackCooldownMs: 15_000,
    };
  }

  return {
    maxRetries: 2,
    baseDelayMs: 1_000,
    maxInteractiveDelayMs: 4_000,
    fallbackCooldownMs: RATE_LIMIT_DEFAULT_COOLDOWN_MS,
  };
}

function getProviderCooldownRemainingMs(provider: DirectLlmProvider): number {
  const entry = providerRateLimitCooldowns.get(provider);
  if (!entry) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    providerRateLimitCooldowns.delete(provider);
    return 0;
  }
  return remaining;
}

function setProviderCooldown(provider: DirectLlmProvider, durationMs: number, reason: string): void {
  providerRateLimitCooldowns.set(provider, {
    until: Date.now() + Math.max(1_000, durationMs),
    reason,
  });
}

function clearProviderCooldown(provider: DirectLlmProvider): void {
  providerRateLimitCooldowns.delete(provider);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimitRetry<T>(fn: () => Promise<T>, config: ResolvedLlmConfig): Promise<T> {
  const { provider, purpose } = config;
  const policy = getRetryPolicy(purpose);
  const cooldownRemaining = getProviderCooldownRemainingMs(provider);
  if (cooldownRemaining > 0) {
    throw new ProviderRequestError({
      provider,
      kind: "rate_limit",
      retryAfterMs: cooldownRemaining,
      message: `${capitalize(provider)} is cooling down after a rate limit. Retry in ${Math.ceil(cooldownRemaining / 1000)}s.`,
    });
  }

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      const result = await fn();
      clearProviderCooldown(provider);
      return result;
    } catch (error) {
      if (attempt < policy.maxRetries && isRateLimitError(error)) {
        const providerError = error instanceof ProviderRequestError ? error : null;
        const requestedDelay = providerError?.retryAfterMs ?? policy.baseDelayMs * Math.pow(2, attempt);
        const delay = Math.max(
          policy.baseDelayMs,
          Math.min(requestedDelay, policy.maxInteractiveDelayMs) + Math.floor(Math.random() * RATE_LIMIT_JITTER_MS),
        );
        if (requestedDelay > policy.maxInteractiveDelayMs) {
          setProviderCooldown(
            provider,
            requestedDelay,
            providerError?.message ?? `${provider} rate limit`,
          );
          throw error;
        }
        console.log(`[LLM] ${provider} 429 rate limit, retry ${attempt + 1}/${policy.maxRetries} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      if (isRateLimitError(error)) {
        const providerError = error instanceof ProviderRequestError ? error : null;
        setProviderCooldown(
          provider,
          providerError?.retryAfterMs ?? policy.fallbackCooldownMs,
          providerError?.message ?? `${provider} rate limit`,
        );
      }
      throw error;
    }
  }
  throw new Error("Unreachable");
}

export function streamResolvedChat(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  callbacks: LlmStreamCallbacks,
  options?: LlmRequestOptions,
): void {
  if (isOpenAiCompatible(config.provider)) {
    streamOpenAiCompatible(config, messages, callbacks, options);
    return;
  }

  void completeResolvedChat(config, messages, options)
    .then((fullText) => {
      for (const chunk of splitIntoStreamChunks(fullText)) {
        callbacks.onToken(chunk);
      }
      callbacks.onDone(fullText);
    })
    .catch((error) => {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    });
}

export async function completeResolvedChat(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  options?: Omit<LlmRequestOptions, "signal">,
): Promise<string> {
  const result = await completeResolvedChatWithTools(config, messages, options);
  return result.text;
}

export async function completeResolvedChatWithTools(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  options?: Omit<LlmRequestOptions, "signal">,
): Promise<LlmCompletion> {
  return withRateLimitRetry(() => {
    if (config.provider === "google") {
      return completeGoogleChat(config, messages, options);
    }
    if (config.provider === "anthropic") {
      return completeAnthropicChat(config, messages, options);
    }
    return completeOpenAiCompatible(config, messages, options);
  }, config);
}

function streamOpenAiCompatible(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  callbacks: LlmStreamCallbacks,
  options?: LlmRequestOptions,
): void {
  const model = options?.model?.trim() || config.model;
  const body = JSON.stringify({
    model,
    messages,
    temperature: options?.temperature ?? 0.2,
    max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  });

  const url = new URL(`${config.baseUrl || OPENAI_COMPATIBLE_BASE_URLS.openai}/chat/completions`);
  const isSecure = url.protocol === "https:";
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Length": Buffer.byteLength(body),
  };

  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://aura.desktop";
    headers["X-Title"] = "Aura Desktop";
  }

  const req = (isSecure ? https : http).request(
    {
      hostname: url.hostname,
      port: url.port || (isSecure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    },
    (response) => {
      if (response.statusCode !== 200) {
        collectErrorResponse(response, config.provider).then(callbacks.onError).catch(callbacks.onError);
        return;
      }

      let buffer = "";
      let fullText = "";
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        callbacks.onDone(fullText);
      };

      response.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) {
            continue;
          }
          if (trimmed === "data: [DONE]") {
            finish();
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
            if (payload.choices?.[0]?.finish_reason === "stop") {
              finish();
            }
          } catch {
            // Ignore malformed SSE chunks.
          }
        }
      });

      response.on("end", () => {
        if (fullText) {
          finish();
          return;
        }
        callbacks.onDone("");
      });

      response.on("error", (error) => {
        callbacks.onError(error);
      });
    },
  );

  req.on("error", (error) => {
    callbacks.onError(error);
  });

  req.on("timeout", () => {
    req.destroy(new Error(`${config.provider} request timed out.`));
  });

  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      req.destroy(new Error("Request aborted."));
    }, { once: true });
  }

  req.write(body);
  req.end();
}

async function completeOpenAiCompatible(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  options?: Omit<LlmRequestOptions, "signal">,
): Promise<LlmCompletion> {
  return new Promise<LlmCompletion>((resolve, reject) => {
    const model = options?.model?.trim() || config.model;
    const bodyObj: Record<string, unknown> = {
      model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (options?.tools && options.tools.length > 0) {
      bodyObj.tools = options.tools.map(tool => ({ type: "function", function: tool }));
    } else {
      bodyObj.stream = true;
    }
    const body = JSON.stringify(bodyObj);

    if (!bodyObj.stream) {
      // Non-streaming code path for tools
      const url = new URL(`${config.baseUrl || OPENAI_COMPATIBLE_BASE_URLS.openai}/chat/completions`);
      const isSecure = url.protocol === "https:";
      const headers: Record<string, string | number> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      };
      if (config.provider === "openrouter") {
        headers["HTTP-Referer"] = "https://aura.desktop";
        headers["X-Title"] = "Aura Desktop";
      }

      const req = (isSecure ? https : http).request(
        {
          hostname: url.hostname,
          port: url.port || (isSecure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (response) => {
          if (response.statusCode !== 200) {
            collectRawResponse(response).then((raw) => {
              const recovered = tryRecoverOpenAiCompatibleToolFailure(config, raw, options);
              if (recovered) {
                resolve(recovered);
                return;
              }
              reject(createProviderError(raw, response.statusCode, config.provider, response.headers));
            }).catch(reject);
            return;
          }
          let raw = "";
          response.on("data", chunk => raw += chunk.toString("utf8"));
          response.on("end", () => {
            try {
              const parsed = JSON.parse(raw);
              const message = parsed.choices?.[0]?.message || {};
              resolve({
                text: message.content || "",
                toolCalls: message.tool_calls || undefined,
              });
            } catch (err) {
              reject(err);
            }
          });
          response.on("error", reject);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`${config.provider} timeout.`)));
      req.write(body);
      req.end();
      return;
    }

    let text = "";
    let settled = false;

    streamOpenAiCompatible(config, messages, {
      onToken: (token) => {
        text += token;
      },
      onDone: (fullText) => {
        if (settled) return;
        settled = true;
        resolve({ text: fullText || text });
      },
      onError: (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      },
    }, options);
  });
}

function tryRecoverOpenAiCompatibleToolFailure(
  _config: ResolvedLlmConfig,
  raw: string,
  options?: Omit<LlmRequestOptions, "signal">,
): LlmCompletion | null {
  if (!options?.tools?.length) {
    return null;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const errorRecord = toRecord(parsed.error);
  const code = stringValue(errorRecord?.code);
  const failedGeneration = stringValue(errorRecord?.failed_generation)
    ?? stringValue(parsed.failed_generation);

  if (code !== "tool_use_failed" || !failedGeneration) {
    return null;
  }

  const recovered = recoverToolCallsFromFailedGeneration(failedGeneration);
  if (recovered.toolCalls.length === 0) {
    return null;
  }

  return {
    text: recovered.text,
    toolCalls: recovered.toolCalls,
  };
}

function recoverToolCallsFromFailedGeneration(
  failedGeneration: string,
): { text: string; toolCalls: LlmToolCall[] } {
  const toolCalls: LlmToolCall[] = [];
  const strippedParts: string[] = [];
  let cursor = 0;
  let guard = 0;

  while (cursor < failedGeneration.length && guard < 32) {
    guard += 1;
    const openIndex = failedGeneration.indexOf("<function=", cursor);
    if (openIndex === -1) {
      strippedParts.push(failedGeneration.slice(cursor));
      break;
    }

    strippedParts.push(failedGeneration.slice(cursor, openIndex));
    const nameStart = openIndex + "<function=".length;
    const jsonStart = failedGeneration.indexOf("{", nameStart);
    if (jsonStart === -1) {
      strippedParts.push(failedGeneration.slice(openIndex));
      break;
    }

    const name = failedGeneration.slice(nameStart, jsonStart).trim();
    const jsonEnd = findMatchingJsonObjectEnd(failedGeneration, jsonStart);
    if (!name || jsonEnd === -1) {
      strippedParts.push(failedGeneration.slice(openIndex));
      break;
    }

    const closeIndex = failedGeneration.indexOf("</function>", jsonEnd + 1);
    if (closeIndex === -1) {
      strippedParts.push(failedGeneration.slice(openIndex));
      break;
    }

    const args = failedGeneration.slice(jsonStart, jsonEnd + 1);
    toolCalls.push({
      id: `recovered_${Date.now()}_${toolCalls.length}`,
      type: "function",
      function: {
        name,
        arguments: args,
      },
    });

    cursor = closeIndex + "</function>".length;
  }

  return {
    text: strippedParts.join("").trim(),
    toolCalls,
  };
}

function findMatchingJsonObjectEnd(source: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (!char) continue;

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

async function completeGoogleChat(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  options?: Omit<LlmRequestOptions, "signal">,
): Promise<LlmCompletion> {
  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => {
      if (typeof message.content === "string") return message.content.trim();
      if (Array.isArray(message.content)) return message.content.map(p => p.type === 'text' ? p.text : "").join(" ").trim();
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const toolCallNames = new Map<string, string>();
  const contents = messages
    .filter((message) => message.role !== "system")
    .flatMap((message) => {
      if (message.role === "tool") {
        const toolName = toolCallNames.get(message.tool_call_id) || message.tool_call_id;
        const entries: Array<{ role: "user"; parts: Array<Record<string, unknown>> }> = [{
          role: "user" as const,
          parts: [{
            functionResponse: buildGoogleFunctionResponse(toolName, message.tool_call_id, message.content),
          }],
        }];

        const inlineParts = extractGoogleInlineDataParts(message.content);
        if (inlineParts.length > 0) {
          entries.push({
            role: "user" as const,
            parts: [
              { text: `Visual output from tool ${toolName}.` },
              ...inlineParts,
            ],
          });
        }

        return entries;
      }

      const role = message.role === "assistant" ? "model" : "user";
      const parts: Array<Record<string, unknown>> = [];
      parts.push(...convertChatContentPartsToGoogleParts(message.content));

      if ("tool_calls" in message && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          toolCallNames.set(toolCall.id, toolCall.function.name);
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: parseJsonArguments(toolCall.function.arguments),
              id: toolCall.id,
            },
          });
        }
      }

      if (parts.length === 0) {
        return [];
      }

      return [{ role, parts }];
    });

  const bodyObj: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options?.temperature ?? 0.2,
    },
  };

  if (systemInstruction) {
    bodyObj.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (options?.tools && options.tools.length > 0) {
    bodyObj.tools = [{
      functionDeclarations: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }];
  }

  const body = JSON.stringify(bodyObj);

  return new Promise<LlmCompletion>((resolve, reject) => {
    const request = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(options?.model?.trim() || config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(createProviderError(raw, response.statusCode, config.provider, response.headers));
            return;
          }

          try {
            const parsed = JSON.parse(raw);
            const candidate = parsed.candidates?.[0];
            const candidateParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
            const text = candidateParts
              .map((part: Record<string, unknown>) => stringValue(part.text) ?? "")
              .join("");
            
            let toolCalls: LlmToolCall[] | undefined;
            const functionCalls = candidateParts.filter((part: Record<string, unknown>) => toRecord(part.functionCall));
            if (functionCalls && functionCalls.length > 0) {
              toolCalls = functionCalls.map((part: Record<string, unknown>, i: number) => {
                const functionCall = toRecord(part.functionCall) ?? {};
                return {
                  id: stringValue(functionCall.id) ?? `${stringValue(functionCall.name) ?? "tool"}_${Date.now()}_${i}`,
                  type: "function" as const,
                  function: {
                    name: stringValue(functionCall.name) ?? "unknown_tool",
                    arguments: JSON.stringify(functionCall.args ?? {}),
                  }
                };
              });
            }

            resolve({ text, toolCalls });
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Could not parse Google response."));
          }
        });
      },
    );

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Google request timed out.")));
    request.write(body);
    request.end();
  });
}

function convertChatContentPartsToGoogleParts(
  content: string | ChatContentPart[] | null,
): Array<Record<string, unknown>> {
  if (!content) {
    return [];
  }

  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ text: part.text });
      continue;
    }

    const inlineData = extractInlineDataFromImageUrl(part.image_url.url);
    if (inlineData) {
      parts.push({ inlineData });
    }
  }
  return parts;
}

function buildGoogleFunctionResponse(
  name: string,
  _toolCallId: string,
  content: string | ChatContentPart[],
): Record<string, unknown> {
  const { response } = normalizeGoogleFunctionResponseContent(content);
  return {
    name,
    response,
  };
}

function extractGoogleInlineDataParts(
  content: string | ChatContentPart[],
): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type !== "image_url") {
      continue;
    }

    const inlineData = extractInlineDataFromImageUrl(part.image_url.url);
    if (inlineData) {
      parts.push({ inlineData });
    }
  }

  return parts;
}

function normalizeGoogleFunctionResponseContent(
  content: string | ChatContentPart[],
): { response: Record<string, unknown>; parts: Array<Record<string, unknown>> } {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (!trimmed) {
      return { response: { result: "Tool completed." }, parts: [] };
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = toRecord(parsed);
      if (record) {
        return { response: record, parts: [] };
      }
      return { response: { result: parsed }, parts: [] };
    } catch {
      return { response: { result: trimmed }, parts: [] };
    }
  }

  const textSegments: string[] = [];
  const multimodalParts: Array<Record<string, unknown>> = [];

  for (const part of content) {
    if (part.type === "text") {
      if (part.text.trim()) {
        textSegments.push(part.text.trim());
      }
      continue;
    }

    const inlineData = extractInlineDataFromImageUrl(part.image_url.url);
    if (inlineData) {
      multimodalParts.push({ inlineData });
    }
  }

  return {
    response: { result: textSegments.join("\n").trim() || "Tool completed." },
    parts: multimodalParts,
  };
}

function extractInlineDataFromImageUrl(
  imageUrl: string,
): { data: string; mimeType: string } | null {
  const match = String(imageUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1] || "image/png",
    data: match[2] || "",
  };
}

function parseJsonArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return toRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

async function completeAnthropicChat(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  options?: Omit<LlmRequestOptions, "signal">,
): Promise<LlmCompletion> {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => {
      if (typeof message.content === "string") return message.content.trim();
      if (Array.isArray(message.content)) return message.content.map(p => p.type === 'text' ? p.text : "").join(" ").trim();
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const anthropicMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user" as const,
          content: [{
            type: "tool_result",
            tool_use_id: (message as any).tool_call_id,
            content: message.content,
          }],
        };
      }
      
      const content: any[] = [];
      if (typeof message.content === "string") {
        content.push({ type: "text", text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const p of message.content) {
          if (p.type === "text") content.push({ type: "text", text: p.text });
          else if (p.type === "image_url") {
            const b64 = p.image_url.url.split(",")[1];
            const mime = p.image_url.url.split(";")[0].split(":")[1] || "image/png";
            content.push({ type: "image", source: { type: "base64", media_type: mime, data: b64 } });
          }
        }
      }

      if ('tool_calls' in message && message.tool_calls) {
        for (const tc of message.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
      }
      return {
        role: message.role as "user" | "assistant",
        content: content.length === 1 && content[0].type === "text" ? [content[0]] : content,
      };
    });

  const bodyObj: Record<string, unknown> = {
    model: options?.model?.trim() || config.model,
    max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options?.temperature ?? 0.2,
    system: system || undefined,
    messages: anthropicMessages,
  };

  if (options?.tools && options.tools.length > 0) {
    bodyObj.tools = options.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  const body = JSON.stringify(bodyObj);

  return new Promise<LlmCompletion>((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(createProviderError(raw, response.statusCode, config.provider, response.headers));
            return;
          }

          try {
            const parsed = JSON.parse(raw);
            const contentParts = parsed.content || [];
            
            const textParts = contentParts.filter((p: any) => p.type === "text").map((p: any) => p.text);
            const toolUseParts = contentParts.filter((p: any) => p.type === "tool_use");
            
            let toolCalls: LlmToolCall[] | undefined;
            if (toolUseParts.length > 0) {
              toolCalls = toolUseParts.map((part: any) => ({
                id: part.id,
                type: "function",
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input),
                }
              }));
            }

            resolve({
              text: textParts.join("") || "",
              toolCalls,
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Could not parse Anthropic response."));
          }
        });
      },
    );

    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Anthropic request timed out.")));
    request.write(body);
    request.end();
  });
}

function splitIntoStreamChunks(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const chunks: string[] = [];
  let current = "";
  const parts = cleaned.split(/(\s+)/).filter(Boolean);

  for (const part of parts) {
    if ((current + part).length > 48 && current) {
      chunks.push(current);
      current = part;
      continue;
    }
    current += part;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function collectRawResponse(response: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    response.on("data", (chunk) => {
      raw += chunk.toString();
    });
    response.on("end", () => {
      resolve(raw);
    });
  });
}

function collectErrorResponse(response: http.IncomingMessage, provider: DirectLlmProvider): Promise<Error> {
  return collectRawResponse(response).then((raw) =>
    createProviderError(raw, response.statusCode, provider, response.headers),
  );
}

function createProviderError(
  raw: string,
  statusCode: number | undefined,
  provider: DirectLlmProvider,
  headers?: http.IncomingHttpHeaders,
): Error {
  const prefix = `${capitalize(provider)} request failed (${statusCode})`;
  const detail = extractProviderErrorDetail(raw);
  const retryAfterMs = parseRetryAfterMs(headers);
  const normalizedDetail = detail.toLowerCase();
  let kind: ProviderErrorKind = "unknown";
  if (statusCode === 429 || normalizedDetail.includes("rate limit") || normalizedDetail.includes("resource exhausted")) {
    kind = "rate_limit";
  } else if (normalizedDetail.includes("quota")) {
    kind = "quota";
  } else if (statusCode === 401 || statusCode === 403) {
    kind = "auth";
  } else if (statusCode === 408) {
    kind = "timeout";
  } else if (typeof statusCode === "number" && statusCode >= 500) {
    kind = "network";
  }

  return new ProviderRequestError({
    provider,
    kind,
    statusCode,
    retryAfterMs,
    message: `${prefix}: ${detail}`,
  });
}

function extractProviderErrorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; status?: string };
      message?: string;
    };
    return parsed.error?.message || parsed.message || parsed.error?.status || raw.slice(0, 240);
  } catch {
    return raw.slice(0, 240);
  }
}

function parseRetryAfterMs(headers?: http.IncomingHttpHeaders): number | undefined {
  if (!headers) return undefined;
  const headerValue = headers["retry-after"];
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const retryDate = Date.parse(value);
  if (!Number.isNaN(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }

  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function capitalize(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
