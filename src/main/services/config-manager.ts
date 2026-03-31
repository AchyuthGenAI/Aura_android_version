import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { OpenClawConfig, ProviderInfo } from "@shared/types";

const DEFAULT_PORT = 18789;

export class ConfigManager {
  private readonly configPath: string;
  private readonly openClawHomePath: string;
  private gatewayToken: string;

  constructor(userDataPath: string) {
    this.openClawHomePath = path.join(userDataPath, "openclaw-home");
    // OpenClaw resolves config as $OPENCLAW_HOME/.openclaw/openclaw.json
    const openClawDotDir = path.join(this.openClawHomePath, ".openclaw");
    this.configPath = path.join(openClawDotDir, "openclaw.json");
    fs.mkdirSync(openClawDotDir, { recursive: true });
    this.gatewayToken = this.ensureGatewayToken();
    // Pre-write auth profile so it's ready before gateway spawns
    this.ensureGroqAuthProfile();
  }

  getOpenClawHomePath(): string {
    return this.openClawHomePath;
  }

  getGatewayToken(): string {
    return this.gatewayToken;
  }

  getGatewayPort(): number {
    return this.readConfig().gateway?.port ?? DEFAULT_PORT;
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

  setModel(model: string, provider?: string): void {
    const config = this.readConfig();
    if (!config.agents) {
      config.agents = {};
    }
    if (!config.agents.main) {
      config.agents.main = {};
    }
    config.agents.main.model = model;
    if (provider) {
      config.agents.main.provider = provider;
    }
    this.writeConfig(config);
  }

  getProviders(): ProviderInfo[] {
    const config = this.readConfig();
    const providers = config.providers ?? {};

    const knownProviders = [
      { id: "groq", name: "Groq" },
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
      { id: "google", name: "Google Gemini" },
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

    if (!config.gateway) {
      config.gateway = {};
      changed = true;
    }
    if (!config.gateway.port) {
      config.gateway.port = DEFAULT_PORT;
      changed = true;
    }
    if (!config.gateway.bind) {
      config.gateway.bind = "loopback";
      changed = true;
    }
    if (!config.gateway.auth) {
      config.gateway.auth = { mode: "token", token: this.gatewayToken };
      changed = true;
    }

    // Ensure the agent is configured to use Groq so OpenClaw doesn't default to Anthropic.
    // OpenClaw reads agents.defaults.model.primary for the model selection.
    if (!config.agents) {
      config.agents = {};
      changed = true;
    }
    if (!config.agents.defaults?.model?.primary) {
      config.agents.defaults = {
        model: {
          primary: "groq/llama-3.3-70b-versatile",
          fallbacks: [],
        },
        models: {
          "groq/llama-3.3-70b-versatile": {},
          "groq/meta-llama/llama-4-scout-17b-16e-instruct": {},
        },
      };
      changed = true;
    }

    if (changed) {
      this.writeConfig(config);
    }

    // Write the Groq auth profile for OpenClaw's agent so it can actually call the API.
    // This is stored as a separate JSON file that OpenClaw reads for provider credentials.
    this.ensureGroqAuthProfile();
  }

  /** Write/update the Groq auth-profiles.json that OpenClaw's agent reads for API keys. */
  ensureGroqAuthProfile(): void {
    // Resolve key from all sources that resolveGroqApiKey() uses
    const config = this.readConfig();
    const groqKey =
      process.env["GROQ_API_KEY"] ||
      process.env["VITE_LLM_API_KEY"] ||
      process.env["PLASMO_PUBLIC_LLM_API_KEY"] ||
      config.providers?.groq?.apiKey ||
      "";
    console.log(`[ConfigManager] ensureGroqAuthProfile — key found=${Boolean(groqKey)} len=${groqKey.length}`);
    if (!groqKey) return; // nothing to write without a key

    // OpenClaw stores auth profiles at:
    // <OPENCLAW_HOME>/.openclaw/agents/main/agent/auth-profiles.json
    const authDir = path.join(this.openClawHomePath, ".openclaw", "agents", "main", "agent");
    const authFile = path.join(authDir, "auth-profiles.json");

    try {
      fs.mkdirSync(authDir, { recursive: true });

      interface AuthProfiles {
        version: number;
        profiles: Record<string, { type: string; provider: string; key: string }>;
        usageStats?: Record<string, unknown>;
      }

      let existing: AuthProfiles = { version: 1, profiles: {} };
      if (fs.existsSync(authFile)) {
        try { existing = JSON.parse(fs.readFileSync(authFile, "utf8")) as AuthProfiles; } catch { /* corrupt — reset */ }
      }

      // Only write if the key changed
      if (existing.profiles?.["groq:aura"]?.key === groqKey) return;

      existing.profiles = existing.profiles ?? {};
      existing.profiles["groq:aura"] = { type: "api_key", provider: "groq", key: groqKey };

      fs.writeFileSync(authFile, JSON.stringify(existing, null, 2), "utf8");
      console.log("[ConfigManager] Wrote Groq auth profile to", authFile);
    } catch (err) {
      console.warn("[ConfigManager] Failed to write Groq auth profile:", err instanceof Error ? err.message : String(err));
    }
  }

  private ensureGatewayToken(): string {
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
      groq: "GROQ_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    return map[providerId] ?? null;
  }
}
