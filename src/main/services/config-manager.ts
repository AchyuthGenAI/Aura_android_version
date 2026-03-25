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
    this.configPath = path.join(this.openClawHomePath, "openclaw.json");
    fs.mkdirSync(this.openClawHomePath, { recursive: true });
    this.gatewayToken = this.ensureGatewayToken();
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

    if (changed) {
      this.writeConfig(config);
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
