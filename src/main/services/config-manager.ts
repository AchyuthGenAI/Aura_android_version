import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { OpenClawConfig, ProviderInfo } from "@shared/types";

const DEFAULT_PORT = 18789;
const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_MANAGED_PROVIDER = "groq";
const VALID_AGENT_PROVIDERS = new Set(["auto", "openclaw", "google", "openai", "openrouter", "anthropic", "groq"]);
const MANAGED_PROVIDER_OVERRIDES = new Set(["openclaw", "google", "openai", "openrouter", "anthropic", "groq"]);
const DEFAULT_AUTOMATION_POLICY_TIER = "safe_auto" as const;
const DEFAULT_AUTOMATION_MAX_STEP_RETRIES = 3;
const DEFAULT_AUTOMATION_WS_PROTOCOL_VERSION = "2026-04-06";
const DEFAULT_AUTOMATION_EVENT_REPLAY_LIMIT = 500;

export class ConfigManager {
  private readonly configPath: string;
  private readonly openClawHomePath: string;
  private gatewayToken: string;

  constructor(userDataPath: string) {
    this.openClawHomePath = path.join(userDataPath, "openclaw-home");
    this.configPath = path.join(this.openClawHomePath, "openclaw.json");
    fs.mkdirSync(this.openClawHomePath, { recursive: true });
    this.gatewayToken = this.ensureGatewayToken();
  }

  getOpenClawHomePath(): string {
    return this.openClawHomePath;
  }

  getGatewayToken(): string {
    return process.env.AURA_GATEWAY_TOKEN
      || process.env.OPENCLAW_GATEWAY_TOKEN
      || process.env.HOOKS_TOKEN
      || process.env.VITE_OPENCLAW_GATEWAY_TOKEN
      || this.gatewayToken;
  }

  getGatewayPort(): number {
    const explicitUrl = this.getGatewayWebSocketUrl();
    try {
      const parsed = new URL(explicitUrl);
      return Number(parsed.port || (parsed.protocol === "wss:" ? 443 : 80));
    } catch {
      return this.readConfig().gateway?.port ?? DEFAULT_PORT;
    }
  }

  getGatewayWebSocketUrl(): string {
    const config = this.readConfig();
    return process.env.AURA_GATEWAY_URL
      || process.env.OPENCLAW_WS
      || process.env.VITE_OPENCLAW_GATEWAY_WS_URL
      || process.env.VITE_OPENCLAW_WS_URL
      || config.gateway?.url
      || `ws://127.0.0.1:${config.gateway?.port ?? DEFAULT_PORT}`;
  }

  getGatewayHttpOrigin(): string {
    const wsUrl = this.getGatewayWebSocketUrl();
    try {
      const parsed = new URL(wsUrl);
      parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return `http://127.0.0.1:${this.getGatewayPort()}`;
    }
  }

  getDefaultSessionKey(): string {
    return process.env.AURA_DEFAULT_SESSION_KEY
      || process.env.OPENCLAW_DEFAULT_SESSION_KEY
      || this.readConfig().agents?.main?.sessionKey
      || DEFAULT_SESSION_KEY;
  }

  isOpenClawPrimaryConfigured(config: OpenClawConfig = this.readConfig()): boolean {
    return (config.agents?.main?.provider?.trim().toLowerCase() ?? DEFAULT_MANAGED_PROVIDER) === "openclaw";
  }

  isOpenClawPrimaryStrict(): boolean {
    const explicit = process.env.AURA_OPENCLAW_PRIMARY_STRICT;
    if (typeof explicit === "string") {
      return explicit === "1" || /^true$/i.test(explicit);
    }
    return Boolean(this.readConfig().automation?.primaryStrict);
  }

  shouldDisableLocalFallback(): boolean {
    const explicit = process.env.AURA_DISABLE_LOCAL_AUTOMATION_FALLBACK;
    if (typeof explicit === "string") {
      return explicit === "1" || /^true$/i.test(explicit);
    }
    const config = this.readConfig();
    return Boolean(config.automation?.primaryStrict)
      || Boolean(config.automation?.disableLocalFallback);
  }

  getAutomationPolicyTier(): "safe_auto" | "confirm" | "locked" {
    const explicit = process.env.AURA_AUTOMATION_POLICY_TIER?.trim().toLowerCase();
    if (explicit === "safe_auto" || explicit === "confirm" || explicit === "locked") {
      return explicit;
    }
    const configured = this.readConfig().automation?.policyTier;
    if (configured === "safe_auto" || configured === "confirm" || configured === "locked") {
      return configured;
    }
    return DEFAULT_AUTOMATION_POLICY_TIER;
  }

  getAutomationMaxStepRetries(): number {
    const explicit = Number(process.env.AURA_AUTOMATION_MAX_STEP_RETRIES ?? "");
    if (Number.isFinite(explicit) && explicit >= 1 && explicit <= 8) {
      return Math.floor(explicit);
    }
    const configured = this.readConfig().automation?.maxStepRetries;
    if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1 && configured <= 8) {
      return Math.floor(configured);
    }
    return DEFAULT_AUTOMATION_MAX_STEP_RETRIES;
  }

  getAutomationWsProtocolVersion(): string {
    const explicit = process.env.AURA_AUTOMATION_WS_PROTOCOL_VERSION?.trim();
    if (explicit) {
      return explicit;
    }
    return this.readConfig().automation?.wsProtocolVersion?.trim() || DEFAULT_AUTOMATION_WS_PROTOCOL_VERSION;
  }

  getAutomationEventReplayLimit(): number {
    const explicit = Number(process.env.AURA_AUTOMATION_EVENT_REPLAY_LIMIT ?? "");
    if (Number.isFinite(explicit) && explicit >= 100 && explicit <= 5000) {
      return Math.floor(explicit);
    }
    const configured = this.readConfig().automation?.eventReplayLimit;
    if (typeof configured === "number" && Number.isFinite(configured) && configured >= 100 && configured <= 5000) {
      return Math.floor(configured);
    }
    return DEFAULT_AUTOMATION_EVENT_REPLAY_LIMIT;
  }

  getGoogleApiKey(): string {
    return process.env.GOOGLE_API_KEY
      || process.env.GEMINI_API_KEY
      || process.env.VITE_GEMINI_API_KEY
      || this.readConfig().providers?.google?.apiKey
      || "";
  }

  getGroqApiKey(): string {
    return process.env.GROQ_API_KEY
      || process.env.VITE_GROQ_API_KEY
      || this.readConfig().providers?.groq?.apiKey
      || "";
  }

  getAnthropicApiKey(): string {
    return process.env.ANTHROPIC_API_KEY
      || process.env.VITE_ANTHROPIC_API_KEY
      || this.readConfig().providers?.anthropic?.apiKey
      || "";
  }

  getApiKeyForProvider(provider: string): string {
    switch (provider.toLowerCase()) {
      case "groq": return this.getGroqApiKey();
      case "google": return this.getGoogleApiKey();
      case "anthropic": return this.getAnthropicApiKey();
      default: return "";
    }
  }

  getDefaultModelForProvider(provider: string): string {
    switch (provider.toLowerCase()) {
      case "groq": return "llama-3.3-70b-versatile";
      case "google": return "gemini-2.0-flash";
      case "anthropic": return "claude-sonnet-4-6";
      default: return "";
    }
  }

  getProviderChain(): string[] {
    const raw = process.env.AURA_PROVIDER_CHAIN || process.env.VITE_AURA_PROVIDER_CHAIN || "groq,google,anthropic";
    const chain = raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    // Filter to providers that actually have an API key configured
    return chain.filter((p) => this.getApiKeyForProvider(p).length > 0);
  }

  shouldAutoStartGateway(): boolean {
    const explicit = process.env.AURA_GATEWAY_AUTOSTART;
    if (typeof explicit === "string") {
      return explicit !== "0" && !/^false$/i.test(explicit);
    }
    const urls = [
      process.env.AURA_GATEWAY_URL,
      process.env.OPENCLAW_WS,
      this.readConfig().gateway?.url,
    ].filter((u): u is string => typeof u === "string" && u.length > 0);
    // Only skip autostart if a URL points to a REMOTE host. Loopback URLs are just
    // the default local config and should still auto-spawn the bundled gateway.
    const hasRemoteGateway = urls.some((u) => {
      try {
        const { hostname } = new URL(u);
        return hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";
      } catch {
        return false;
      }
    });
    return !hasRemoteGateway;
  }

  readConfig(): OpenClawConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, "utf8")) as OpenClawConfig;
      }
    } catch {
      // corrupt config — return defaults
    }
    return {};
  }

  setAgentProvider(provider: string, model?: string): void {
    const config = this.readConfig();
    if (!config.agents) config.agents = {};
    if (!config.agents.main) config.agents.main = {};
    config.agents.main.provider = provider;
    config.agents.main.model = model || this.getDefaultModelForProvider(provider);
    if (!config.providers) config.providers = {};
    const apiKey = this.getApiKeyForProvider(provider);
    if (apiKey) {
      config.providers[provider] = { apiKey, enabled: true };
    }
    this.writeConfig(config);
  }

  writeConfig(config: OpenClawConfig): void {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf8");
  }

  setApiKey(provider: string, apiKey: string): void {
    const config = this.readConfig();
    if (!config.providers) {
      config.providers = {};
    }
    config.providers[provider] = {
      ...config.providers[provider],
      apiKey,
      enabled: true,
    };
    this.writeConfig(config);
  }

  updateAgent(payload: { provider?: string; model?: string }): void {
    const config = this.readConfig();
    if (!config.agents) {
      config.agents = {};
    }
    if (!config.agents.main) {
      config.agents.main = {};
    }

    if (typeof payload.provider === "string") {
      const provider = payload.provider.trim();
      if (provider) {
        config.agents.main.provider = provider;
      } else {
        delete config.agents.main.provider;
      }
    }

    if (typeof payload.model === "string") {
      const model = payload.model.trim();
      if (model) {
        config.agents.main.model = model;
      } else {
        delete config.agents.main.model;
      }
    }

    this.enforceOpenClawBinding(config);
    this.writeConfig(config);
  }

  setModel(model: string, provider?: string): void {
    this.updateAgent({ model, provider });
  }

  updateAutomation(payload: {
    primaryStrict?: boolean;
    disableLocalFallback?: boolean;
    policyTier?: "safe_auto" | "confirm" | "locked";
    maxStepRetries?: number;
    wsProtocolVersion?: string;
    eventReplayLimit?: number;
  }): void {
    const config = this.readConfig();
    if (!config.automation) {
      config.automation = {};
    }

    if (typeof payload.primaryStrict === "boolean") {
      config.automation.primaryStrict = payload.primaryStrict;
      if (payload.primaryStrict && typeof payload.disableLocalFallback !== "boolean") {
        config.automation.disableLocalFallback = true;
      }
    }

    if (typeof payload.disableLocalFallback === "boolean") {
      config.automation.disableLocalFallback = payload.disableLocalFallback;
    }

    this.enforceOpenClawBinding(config);

    if (
      payload.policyTier === "safe_auto"
      || payload.policyTier === "confirm"
      || payload.policyTier === "locked"
    ) {
      config.automation.policyTier = payload.policyTier;
    }

    if (
      typeof payload.maxStepRetries === "number"
      && Number.isFinite(payload.maxStepRetries)
      && payload.maxStepRetries >= 1
      && payload.maxStepRetries <= 8
    ) {
      config.automation.maxStepRetries = Math.floor(payload.maxStepRetries);
    }

    if (typeof payload.wsProtocolVersion === "string") {
      const normalized = payload.wsProtocolVersion.trim();
      if (normalized) {
        config.automation.wsProtocolVersion = normalized;
      }
    }

    if (
      typeof payload.eventReplayLimit === "number"
      && Number.isFinite(payload.eventReplayLimit)
      && payload.eventReplayLimit >= 100
      && payload.eventReplayLimit <= 5000
    ) {
      config.automation.eventReplayLimit = Math.floor(payload.eventReplayLimit);
    }

    this.writeConfig(config);
  }

  setGatewaySettings(payload: { url?: string; token?: string; sessionKey?: string }): void {
    const config = this.readConfig();
    if (!config.gateway) {
      config.gateway = {};
    }
    if (!config.gateway.auth) {
      config.gateway.auth = {};
    }
    if (!config.agents) {
      config.agents = {};
    }
    if (!config.agents.main) {
      config.agents.main = {};
    }

    if (typeof payload.url === "string") {
      const url = payload.url.trim();
      if (url) {
        config.gateway.url = url;
      } else {
        delete config.gateway.url;
      }
    }

    if (typeof payload.token === "string") {
      const token = payload.token.trim();
      if (token) {
        config.gateway.auth.mode = "token";
        config.gateway.auth.token = token;
        this.gatewayToken = token;
      } else {
        config.gateway.auth.mode = "token";
        config.gateway.auth.token = this.gatewayToken || crypto.randomUUID();
      }
    }

    if (typeof payload.sessionKey === "string") {
      const sessionKey = payload.sessionKey.trim();
      if (sessionKey) {
        config.agents.main.sessionKey = sessionKey;
      } else {
        delete config.agents.main.sessionKey;
      }
    }

    this.writeConfig(config);
  }

  getProviders(): ProviderInfo[] {
    const config = this.readConfig();
    const providers = config.providers ?? {};

    const knownProviders = [
      { id: "groq", name: "Groq" },
      { id: "google", name: "Google Gemini" },
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
      { id: "openrouter", name: "OpenRouter" },
    ];

    return knownProviders.map((p) => {
      const providerConfig = providers[p.id];
      const envKey = this.getEnvKeyForProvider(p.id);
      const hasEnvKey = Boolean(envKey && process.env[envKey]);
      const hasConfigKey = Boolean(providerConfig?.apiKey);

      return {
        id: p.id,
        name: p.name,
        configured: hasEnvKey || hasConfigKey,
        managed: hasEnvKey && !hasConfigKey,
        model: config.agents?.main?.provider === p.id ? config.agents.main.model : undefined,
      };
    });
  }

  ensureDefaults(): void {
    const config = this.readConfig();
    let changed = false;
    const managedProvider = this.resolveManagedProvider();
    const managedModel = this.resolveManagedModel();
    const managedGatewayUrl =
      process.env.AURA_GATEWAY_URL
      || process.env.OPENCLAW_WS
      || process.env.VITE_OPENCLAW_GATEWAY_WS_URL
      || process.env.VITE_OPENCLAW_WS_URL
      || "";
    const managedSessionKey =
      process.env.AURA_DEFAULT_SESSION_KEY
      || process.env.OPENCLAW_DEFAULT_SESSION_KEY
      || "";
    const managedGatewayToken =
      process.env.AURA_GATEWAY_TOKEN
      || process.env.OPENCLAW_GATEWAY_TOKEN
      || process.env.HOOKS_TOKEN
      || process.env.VITE_OPENCLAW_GATEWAY_TOKEN
      || this.gatewayToken;

    if (!config.gateway) {
      config.gateway = {};
      changed = true;
    }
    if (!config.gateway.port) {
      config.gateway.port = DEFAULT_PORT;
      changed = true;
    }
    if (managedGatewayUrl) {
      if (config.gateway.url !== managedGatewayUrl) {
        config.gateway.url = managedGatewayUrl;
        changed = true;
      }
    } else if (typeof config.gateway.url === "string" && !config.gateway.url.trim()) {
      delete config.gateway.url;
      changed = true;
    }
    if (!config.gateway.bind) {
      config.gateway.bind = "loopback";
      changed = true;
    }
    if (!config.gateway.mode) {
      config.gateway.mode = "local";
      changed = true;
    }
    if (!config.gateway.auth) {
      config.gateway.auth = { mode: "token", token: managedGatewayToken };
      changed = true;
    } else {
      if (config.gateway.auth.mode !== "token") {
        config.gateway.auth.mode = "token";
        changed = true;
      }
      if (config.gateway.auth.token !== managedGatewayToken) {
        config.gateway.auth.token = managedGatewayToken;
        changed = true;
      }
    }

    if (!config.agents) {
      config.agents = {};
      changed = true;
    }
    if (!config.agents.main) {
      config.agents.main = {};
      changed = true;
    }
    let currentProvider = config.agents.main.provider?.trim().toLowerCase();
    if (!currentProvider || !VALID_AGENT_PROVIDERS.has(currentProvider)) {
      currentProvider = managedProvider;
    }
    // Aura is hard-forked to route *every* chat turn through the OpenClaw
    // gateway (vendor/openclaw/openclaw.mjs). The gateway itself owns the
    // upstream LLM call (Groq primary, Gemini fallback) so from the UI's
    // point of view all traffic is OpenClaw-native. Force the configured
    // provider to "openclaw" on every startup so older persisted configs
    // (or settings churn) can never break this invariant.
    if (currentProvider !== "openclaw") {
      console.log(`[ConfigManager] Pinning agent provider '${currentProvider}' -> 'openclaw' (hard-forked end-to-end routing)`);
      currentProvider = "openclaw";
    }
    if (config.agents.main.provider !== currentProvider) {
      config.agents.main.provider = currentProvider;
      changed = true;
    }
    if (managedSessionKey) {
      if (config.agents.main.sessionKey !== managedSessionKey) {
        config.agents.main.sessionKey = managedSessionKey;
        changed = true;
      }
    } else if (!config.agents.main.sessionKey?.trim()) {
      config.agents.main.sessionKey = DEFAULT_SESSION_KEY;
      changed = true;
    } else if (config.agents.main.sessionKey !== config.agents.main.sessionKey.trim()) {
      config.agents.main.sessionKey = config.agents.main.sessionKey.trim();
      changed = true;
    }
    const resolvedModel = managedModel || this.getDefaultModelForProvider(currentProvider);
    if (resolvedModel && config.agents.main.model !== resolvedModel) {
      config.agents.main.model = resolvedModel;
      changed = true;
    }
    // Propagate API key from env into providers.{name}.apiKey so OpenClaw picks it up
    if (!config.providers) {
      config.providers = {};
      changed = true;
    }
    const envKey = this.getApiKeyForProvider(currentProvider);
    if (envKey) {
      const existing = config.providers[currentProvider];
      if (!existing || existing.apiKey !== envKey || existing.enabled === false) {
        config.providers[currentProvider] = { apiKey: envKey, enabled: true };
        changed = true;
      }
    }

    if (!config.automation) {
      config.automation = {};
      changed = true;
    }
    // Aura's hard-forked OpenClaw runtime now services chat.send end-to-end
    // (vendor/openclaw/openclaw.mjs streams Groq/Gemini directly). Pin
    // primaryStrict=true on every startup so every prompt must flow through
    // the gateway and the local direct-LLM path is never used.
    if (config.automation.primaryStrict !== true) {
      config.automation.primaryStrict = true;
      changed = true;
    }
    if (
      config.automation.policyTier !== "safe_auto"
      && config.automation.policyTier !== "confirm"
      && config.automation.policyTier !== "locked"
    ) {
      config.automation.policyTier = DEFAULT_AUTOMATION_POLICY_TIER;
      changed = true;
    }
    if (
      typeof config.automation.maxStepRetries !== "number"
      || !Number.isFinite(config.automation.maxStepRetries)
      || config.automation.maxStepRetries < 1
    ) {
      config.automation.maxStepRetries = DEFAULT_AUTOMATION_MAX_STEP_RETRIES;
      changed = true;
    }
    // Paired with primaryStrict above: the gateway fully owns the chat
    // pipeline, so local fallback must stay disabled. This keeps "everything
    // through OpenClaw" as a hard invariant of this build.
    if (config.automation.disableLocalFallback !== true) {
      config.automation.disableLocalFallback = true;
      changed = true;
    }
    if (!config.automation.wsProtocolVersion) {
      config.automation.wsProtocolVersion = DEFAULT_AUTOMATION_WS_PROTOCOL_VERSION;
      changed = true;
    }
    if (
      typeof config.automation.eventReplayLimit !== "number"
      || !Number.isFinite(config.automation.eventReplayLimit)
      || config.automation.eventReplayLimit < 100
    ) {
      config.automation.eventReplayLimit = DEFAULT_AUTOMATION_EVENT_REPLAY_LIMIT;
      changed = true;
    }

    if (changed) {
      this.enforceOpenClawBinding(config);
      this.writeConfig(config);
    }
  }

  private enforceOpenClawBinding(config: OpenClawConfig): void {
    if (!config.automation?.primaryStrict) {
      return;
    }

    if (!config.automation) {
      config.automation = {};
    }

    config.automation.disableLocalFallback = true;
  }

  private ensureGatewayToken(): string {
    const envToken =
      process.env.AURA_GATEWAY_TOKEN
      || process.env.OPENCLAW_GATEWAY_TOKEN
      || process.env.HOOKS_TOKEN
      || process.env.VITE_OPENCLAW_GATEWAY_TOKEN;
    if (envToken) {
      return envToken;
    }

    const config = this.readConfig();
    const existing = config.gateway?.auth?.token;
    if (existing) {
      return existing;
    }

    const token = crypto.randomUUID();
    if (!config.gateway) {
      config.gateway = {};
    }
    if (!config.gateway.auth) {
      config.gateway.auth = {};
    }
    config.gateway.auth.mode = "token";
    config.gateway.auth.token = token;
    this.writeConfig(config);
    return token;
  }

  private getEnvKeyForProvider(providerId: string): string | null {
    const map: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      groq: "GROQ_API_KEY",
    };
    return map[providerId] ?? null;
  }

  private resolveManagedProvider(): string {
    const explicitProvider =
      process.env.AURA_LLM_PROVIDER
      || process.env.VITE_LLM_PROVIDER
      || process.env.PLASMO_PUBLIC_LLM_PROVIDER;
    const normalized = explicitProvider?.trim().toLowerCase();
    if (normalized && MANAGED_PROVIDER_OVERRIDES.has(normalized)) {
      return normalized;
    }
    return DEFAULT_MANAGED_PROVIDER;
  }

  private resolveManagedModel(): string | undefined {
    const explicitModel =
      process.env.AURA_LLM_MODEL
      || process.env.VITE_LLM_MODEL
      || process.env.PLASMO_PUBLIC_LLM_MODEL;
    const normalized = explicitModel?.trim();
    return normalized || undefined;
  }
}
