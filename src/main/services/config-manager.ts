import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { OpenClawConfig, ProviderInfo } from "@shared/types";

const DEFAULT_PORT = 18789;
const WORKSPACE_STATE_VERSION = 1;

const AURA_AGENTS_TEMPLATE = `# AGENTS.md - Aura Operator Workspace

This workspace belongs to Aura Desktop, a user-friendly shell around OpenClaw.

## Role

You are Aura, the user's local desktop operator.
Your job is to use OpenClaw's tools and skills to complete real tasks on this PC and in the built-in browser.

## Priorities

1. Complete the user's requested task end to end.
2. Prefer action over explanation.
3. Keep replies short while work is in progress.
4. Use the desktop and browser directly instead of describing what you would do.

## Critical Boundary

- Aura is the UI shell. It is not the target app.
- Never type into Aura's own chat box or any Aura UI unless the user explicitly asks you to interact with Aura itself.
- For desktop tasks, launch or focus the real target app first, then continue inside that app until the requested work is done.
- Launching an app is progress, not completion, when the user asked for work inside the app.

## Execution Style

- Prefer direct tool use over long plans.
- For desktop tasks: open app -> wait -> inspect windows -> focus target window -> type/click/save.
- For browser tasks: use the browser tool and stay inside the browser flow until the task is finished.
- If a tool result says taskComplete is false or continueRequired is true, keep going.

## Approvals and Safety

- Ask only when an approval, permission, or risky external action is actually required.
- Do not send public/external messages unless the user asked for them.
- Do not inspect workspace bootstrap/template files during normal task execution unless the user explicitly asked for workspace maintenance.

## Workspace Use

- Treat this workspace as runtime support, not as the main task target.
- Do not drift into HEARTBEAT.md, BOOTSTRAP.md, template discovery, or memory review during ordinary desktop/browser tasks.
- Only read or edit workspace files when the user explicitly asks for documentation, memory, skills, or workspace maintenance.
`;

const AURA_SOUL_TEMPLATE = `# SOUL.md - Aura

Aura should feel calm, fast, capable, and practical.

## Personality

- Warm, but not chatty
- Confident, but not theatrical
- Helpful, but not verbose
- Action-oriented, not plan-dumping

## Communication

- Acknowledge briefly
- Start working quickly
- Explain only what matters for trust, approval, or recovery
- When blocked, say exactly what is needed next

## Product Intent

Aura exists so normal users can access OpenClaw's real automation abilities without needing to understand the underlying gateway, workspace, sessions, or tooling model.
`;

const AURA_TOOLS_TEMPLATE = `# TOOLS.md - Aura Runtime Notes

Use OpenClaw's native tools and skills as the source of truth.

## Desktop

- Prefer direct app launch and window focus actions over typing app names into the current focus.
- The Aura widget may be visible, but it is not the target app.

## Browser

- Use the built-in browser when the task is clearly web navigation or web interaction.
- Explicit URLs and well-known sites are fine for browser navigation.
- Local apps like Notepad, Calculator, VS Code, Terminal, etc. are desktop tasks, not websites.

## Wrapper Boundary

- Aura owns UI, approvals, visibility, and task status surfaces.
- OpenClaw owns planning, task continuation, browser automation, desktop automation, cron, and skills.
`;

const AURA_IDENTITY_TEMPLATE = `# IDENTITY.md

- Name: Aura
- Creature: Local desktop assistant
- Vibe: Calm, capable, polished
- Emoji: orb
- Avatar: 

Aura is the friendly wrapper users see, but the runtime uses OpenClaw's skills and tools to do the real work.
`;

const AURA_HEARTBEAT_TEMPLATE = `# HEARTBEAT.md

Keep this file intentionally minimal.

Heartbeat should stay quiet unless the user explicitly configures proactive checks.
`;

const AURA_MEMORY_TEMPLATE = `# MEMORY.md

Use this file only for durable user-specific preferences that matter across sessions.
Keep it concise.
`;

const DEFAULT_FILE_MARKERS: Record<string, string[]> = {
  "AGENTS.md": ["# AGENTS.md - Your Workspace", "## First Run", "## Session Startup"],
  "SOUL.md": ["# SOUL.md - Who You Are", "## Core Truths"],
  "TOOLS.md": ["# TOOLS.md - Local Notes", "## What Goes Here"],
  "IDENTITY.md": ["# IDENTITY.md - Who Am I?", "_Fill this in during your first conversation."],
  "HEARTBEAT.md": ["# HEARTBEAT.md Template", "Keep this file empty"],
  "BOOTSTRAP.md": ["# BOOTSTRAP.md - Hello, World", "You just woke up. Time to figure out who you are."],
};

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
    // Pre-write auth profiles so they're ready before gateway spawns
    this.ensureGroqAuthProfile();
    this.ensureGeminiAuthProfile();
    this.ensureAuraManagedWorkspace();
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

    // Ensure the agent is configured to use a sane provider stack for task execution.
    // OpenClaw reads agents.defaults.model.primary for the model selection.
    if (!config.agents) {
      config.agents = {};
      changed = true;
    }
    if (config.agents.defaults?.workspace !== path.join(this.openClawHomePath, ".openclaw", "workspace")) {
      config.agents.defaults = {
        ...(config.agents.defaults ?? {}),
        workspace: path.join(this.openClawHomePath, ".openclaw", "workspace"),
      };
      changed = true;
    }
    const currentPrimary = config.agents.defaults?.model?.primary;
    const groqKey =
      process.env["GROQ_API_KEY"] ||
      process.env["VITE_LLM_API_KEY"] ||
      process.env["PLASMO_PUBLIC_LLM_API_KEY"] ||
      config.providers?.groq?.apiKey ||
      "";
    const googleKey = process.env["GOOGLE_API_KEY"] || config.providers?.google?.apiKey || "";
    const hasGroq = Boolean(groqKey);
    const hasGoogle = Boolean(googleKey);

    const preferredPrimary = hasGroq ? "groq/llama-3.3-70b-versatile" : "google/gemini-2.0-flash";
    const fallbackModels: string[] = [];

    if (hasGroq && preferredPrimary !== "groq/llama-3.3-70b-versatile") {
      fallbackModels.push("groq/llama-3.3-70b-versatile");
    }
    if (hasGroq) {
      fallbackModels.push("groq/llama-3.1-8b-instant");
    }
    if (hasGoogle && preferredPrimary !== "google/gemini-2.0-flash") {
      fallbackModels.push("google/gemini-2.0-flash");
    }

    const shouldRefreshDefaults =
      !currentPrimary ||
      currentPrimary === "google/gemini-2.0-flash" ||
      currentPrimary === "groq/llama-3.3-70b-versatile" ||
      currentPrimary === "google/gemini-1.5-pro" ||
      currentPrimary === "google/gemini-3.0-flash" ||
      currentPrimary === "google/gemini-2.5-pro";

    if (shouldRefreshDefaults) {
      const models: Record<string, Record<string, never>> = {};
      models[preferredPrimary] = {};
      for (const model of fallbackModels) {
        models[model] = {};
      }

      config.agents.defaults = {
        ...(config.agents.defaults ?? {}),
        workspace: path.join(this.openClawHomePath, ".openclaw", "workspace"),
        model: {
          primary: preferredPrimary,
          fallbacks: fallbackModels,
        },
        models,
      };
      changed = true;
    }

    if (changed) {
      this.writeConfig(config);
    }

    // Write auth profiles for both Gemini and Groq
    this.ensureGroqAuthProfile();
    this.ensureGeminiAuthProfile();
    this.ensureAuraManagedWorkspace();
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

  /** Write/update the Gemini auth-profiles.json entry that OpenClaw's agent reads for Google API keys. */
  ensureGeminiAuthProfile(): void {
    const config = this.readConfig();
    const geminiKey =
      process.env["GOOGLE_API_KEY"] ||
      config.providers?.google?.apiKey ||
      "";
    console.log(`[ConfigManager] ensureGeminiAuthProfile — key found=${Boolean(geminiKey)} len=${geminiKey.length}`);
    if (!geminiKey) return;

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

      if (existing.profiles?.["google:aura"]?.key === geminiKey) return;

      existing.profiles = existing.profiles ?? {};
      existing.profiles["google:aura"] = { type: "api_key", provider: "google", key: geminiKey };

      fs.writeFileSync(authFile, JSON.stringify(existing, null, 2), "utf8");
      console.log("[ConfigManager] Wrote Gemini auth profile to", authFile);
    } catch (err) {
      console.warn("[ConfigManager] Failed to write Gemini auth profile:", err instanceof Error ? err.message : String(err));
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

  private ensureAuraManagedWorkspace(): void {
    const workspaceDir = path.join(this.openClawHomePath, ".openclaw", "workspace");
    const workspaceStateDir = path.join(workspaceDir, ".openclaw");
    const workspaceStatePath = path.join(workspaceStateDir, "workspace-state.json");

    try {
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(workspaceStateDir, { recursive: true });

      this.writeManagedWorkspaceFile(path.join(workspaceDir, "AGENTS.md"), AURA_AGENTS_TEMPLATE, "AGENTS.md");
      this.writeManagedWorkspaceFile(path.join(workspaceDir, "SOUL.md"), AURA_SOUL_TEMPLATE, "SOUL.md");
      this.writeManagedWorkspaceFile(path.join(workspaceDir, "TOOLS.md"), AURA_TOOLS_TEMPLATE, "TOOLS.md");
      this.writeManagedWorkspaceFile(path.join(workspaceDir, "IDENTITY.md"), AURA_IDENTITY_TEMPLATE, "IDENTITY.md");
      this.writeManagedWorkspaceFile(path.join(workspaceDir, "HEARTBEAT.md"), AURA_HEARTBEAT_TEMPLATE, "HEARTBEAT.md");
      this.writeManagedWorkspaceFile(path.join(workspaceDir, "MEMORY.md"), AURA_MEMORY_TEMPLATE, "MEMORY.md");

      const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md");
      if (fs.existsSync(bootstrapPath)) {
        fs.rmSync(bootstrapPath, { force: true });
      }

      const userPath = path.join(workspaceDir, "USER.md");
      if (!fs.existsSync(userPath)) {
        fs.writeFileSync(userPath, "Name: User\nWhat to call them: User\nPronouns:\nTimezone:\nNotes:\n", "utf8");
      }

      const previousState = this.readWorkspaceState(workspaceStatePath);
      const nextState = {
        version: WORKSPACE_STATE_VERSION,
        bootstrapSeededAt: previousState?.bootstrapSeededAt ?? new Date().toISOString(),
        setupCompletedAt: previousState?.setupCompletedAt ?? new Date().toISOString(),
      };
      fs.writeFileSync(workspaceStatePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    } catch (err) {
      console.warn(
        "[ConfigManager] Failed to initialize Aura-managed workspace:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private writeManagedWorkspaceFile(filePath: string, content: string, fileName: string): void {
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
    if (current !== null && !this.shouldReplaceManagedWorkspaceFile(current, fileName)) {
      return;
    }
    fs.writeFileSync(filePath, `${content.trim()}\n`, "utf8");
  }

  private shouldReplaceManagedWorkspaceFile(current: string, fileName: string): boolean {
    const trimmed = current.trim();
    if (!trimmed) {
      return true;
    }
    const markers = DEFAULT_FILE_MARKERS[fileName] ?? [];
    return markers.some((marker) => trimmed.includes(marker));
  }

  private readWorkspaceState(
    filePath: string,
  ): { bootstrapSeededAt?: string; setupCompletedAt?: string } | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        bootstrapSeededAt?: string;
        setupCompletedAt?: string;
      };
    } catch {
      return null;
    }
  }
}
