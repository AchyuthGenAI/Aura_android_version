import { useEffect, useState } from "react";

import type {
  AuraSettings,
  OpenClawConfig,
  PermissionState,
  ProviderInfo,
  ThemeMode,
} from "@shared/types";

import { desktopEnv } from "@renderer/config/env";
import { useAuraStore } from "@renderer/store/useAuraStore";

import { SectionHeading, SettingRow, Switch } from "../shared";

type EditableProvider = "auto" | "openclaw" | "openai" | "openrouter" | "google" | "anthropic" | "groq";
type DirectProvider = Exclude<EditableProvider, "auto" | "openclaw">;
type AutomationPolicyTier = "safe_auto" | "confirm" | "locked";

const PROVIDER_OPTIONS: Array<{ id: EditableProvider; label: string; detail: string }> = [
  { id: "auto", label: "Auto", detail: "Let Aura choose between OpenClaw and local/direct automation paths based on task type, availability, and your runtime settings." },
  { id: "openclaw", label: "OpenClaw", detail: "Prefer the OpenClaw gateway for chat and automation, with local fallback still available unless strict mode disables it." },
  { id: "groq", label: "Groq", detail: "Use Groq-hosted Llama models for fast, free-tier-friendly direct chat and planning." },
  { id: "google", label: "Google Gemini", detail: "Use Gemini for direct planning, chat, and monitor evaluation." },
  { id: "openai", label: "OpenAI", detail: "Route direct chat and planning through OpenAI." },
  { id: "openrouter", label: "OpenRouter", detail: "Use an OpenRouter model with your own key." },
  { id: "anthropic", label: "Anthropic", detail: "Use Claude for direct planning and chat." },
];

const DEFAULT_MODELS: Record<EditableProvider, string> = {
  auto: "",
  openclaw: "",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
  google: "gemini-2.0-flash",
  anthropic: "claude-3-5-haiku-latest",
  groq: "llama-3.3-70b-versatile",
};
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

const FIELD_CLASS =
  "w-full rounded-[14px] border border-white/[0.08] bg-black/25 px-3.5 py-2.5 text-[14px] text-aura-text outline-none transition-all focus:border-aura-violet/40 focus:shadow-[0_0_12px_rgba(124,58,237,0.08)]";

const isDirectProvider = (value: EditableProvider): value is DirectProvider =>
  value !== "auto" && value !== "openclaw";

export const SettingsPage = (): JSX.Element => {
  const settings = useAuraStore((state) => state.settings);
  const permissions = useAuraStore((state) => state.permissions);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const saveSettings = useAuraStore((state) => state.saveSettings);
  const savePermissions = useAuraStore((state) => state.savePermissions);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<EditableProvider>("auto");
  const [model, setModel] = useState("");
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [sessionKey, setSessionKey] = useState("agent:main:main");
  const [automationPrimaryStrict, setAutomationPrimaryStrict] = useState(false);
  const [disableLocalFallback, setDisableLocalFallback] = useState(false);
  const [automationPolicyTier, setAutomationPolicyTier] = useState<AutomationPolicyTier>("safe_auto");
  const [maxStepRetries, setMaxStepRetries] = useState(3);
  const [wsProtocolVersion, setWsProtocolVersion] = useState("");
  const [eventReplayLimit, setEventReplayLimit] = useState(500);
  const [isSavingRuntime, setIsSavingRuntime] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeConfig = async (): Promise<void> => {
      try {
        const [config, providerInfo] = await Promise.all([
          window.auraDesktop.config.get(),
          window.auraDesktop.config.getProviders(),
        ]);
        if (cancelled) return;

        hydrateRuntimeEditor(config as OpenClawConfig, providerInfo, {
          setProviders,
          setSelectedProvider,
          setModel,
          setProviderKeys,
          setGatewayUrl,
          setGatewayToken,
          setSessionKey,
          setAutomationPrimaryStrict,
          setDisableLocalFallback,
          setAutomationPolicyTier,
          setMaxStepRetries,
          setWsProtocolVersion,
          setEventReplayLimit,
        });
      } catch (error) {
        if (!cancelled) {
          setRuntimeNotice(error instanceof Error ? error.message : "Could not load runtime settings.");
        }
      }
    };

    void loadRuntimeConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProviderMeta = PROVIDER_OPTIONS.find((entry) => entry.id === selectedProvider) ?? PROVIDER_OPTIONS[0]!;
  const selectedKey = isDirectProvider(selectedProvider) ? providerKeys[selectedProvider] ?? "" : "";
  const runtimeModelLabel =
    model
    || (selectedProvider === "openclaw"
      ? "Gateway-managed model"
      : selectedProvider === "auto"
        ? "Best configured direct provider (Google Gemini default)"
        : DEFAULT_MODELS[selectedProvider] || "Provider default");
  const runtimeEditingEnabled = settings.advancedMode;
  const openClawBoundMode = automationPrimaryStrict;

  const saveRuntimeConfig = async (): Promise<void> => {
    setIsSavingRuntime(true);
    setRuntimeNotice(null);

    try {
      const effectiveProvider = selectedProvider;
      await window.auraDesktop.config.updateAgent({
        provider: effectiveProvider,
        model: model.trim(),
      });

      if (isDirectProvider(effectiveProvider)) {
        await window.auraDesktop.config.setApiKey({
          provider: effectiveProvider,
          apiKey: providerKeys[effectiveProvider]?.trim() || "",
        });
      }

      await window.auraDesktop.config.setGateway({
        url: gatewayUrl.trim(),
        token: gatewayToken.trim(),
        sessionKey: sessionKey.trim(),
      });

      await window.auraDesktop.config.updateAutomation({
        primaryStrict: automationPrimaryStrict,
        disableLocalFallback: automationPrimaryStrict || disableLocalFallback,
        policyTier: automationPolicyTier,
        maxStepRetries,
        wsProtocolVersion: wsProtocolVersion.trim(),
        eventReplayLimit,
      });

      await window.auraDesktop.runtime.restart();

      const [config, providerInfo] = await Promise.all([
        window.auraDesktop.config.get(),
        window.auraDesktop.config.getProviders(),
      ]);

      hydrateRuntimeEditor(config as OpenClawConfig, providerInfo, {
        setProviders,
        setSelectedProvider,
        setModel,
        setProviderKeys,
        setGatewayUrl,
        setGatewayToken,
        setSessionKey,
        setAutomationPrimaryStrict,
        setDisableLocalFallback,
        setAutomationPolicyTier,
        setMaxStepRetries,
        setWsProtocolVersion,
        setEventReplayLimit,
      });
      setRuntimeNotice("Runtime settings saved and Aura restarted the OpenClaw bridge.");
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : "Could not save runtime settings.");
    } finally {
      setIsSavingRuntime(false);
    }
  };

  const restartRuntime = async (): Promise<void> => {
    setIsSavingRuntime(true);
    setRuntimeNotice(null);
    try {
      await window.auraDesktop.runtime.restart();
      setRuntimeNotice("Aura restarted the local runtime.");
    } catch (error) {
      setRuntimeNotice(error instanceof Error ? error.message : "Could not restart Aura.");
    } finally {
      setIsSavingRuntime(false);
    }
  };

  return (
    <div className="mx-auto mt-2 flex h-full w-full max-w-[1280px] flex-col overflow-y-auto pb-8 pr-2">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(360px,420px)]">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col">
            <SectionHeading title="Desktop Preferences" detail="Tune the shell behavior, privacy posture, and startup experience." />
            <div className="mt-5 grid gap-4 rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-6 xl:grid-cols-2">
              <SettingRow
                label="Theme"
                detail="Switch the desktop shell between dark and light."
                control={
                  <select
                    value={settings.theme}
                    onChange={(event) => void saveSettings({ ...settings, theme: event.target.value as ThemeMode })}
                    className={FIELD_CLASS}
                  >
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                }
              />
              <SettingRow
                label="Privacy Mode"
                detail="Control how conservatively Aura handles local context."
                control={
                  <select
                    value={settings.privacyMode}
                    onChange={(event) => void saveSettings({ ...settings, privacyMode: event.target.value as AuraSettings["privacyMode"] })}
                    className={FIELD_CLASS}
                  >
                    <option value="standard">Standard</option>
                    <option value="strict">Strict</option>
                  </select>
                }
              />
              <SettingRow
                label="Voice Mode"
                detail="Enable voice interaction for Aura sessions."
                control={<Switch checked={settings.voiceEnabled} onChange={(checked) => void saveSettings({ ...settings, voiceEnabled: checked })} />}
              />
              <SettingRow
                label="Advanced Mode"
                detail="Expose more power-user behaviors in the desktop app."
                control={<Switch checked={settings.advancedMode} onChange={(checked) => void saveSettings({ ...settings, advancedMode: checked })} />}
              />
              <SettingRow
                label="Launch On Startup"
                detail="Start Aura automatically when you sign into Windows."
                control={<Switch checked={settings.launchOnStartup} onChange={(checked) => void saveSettings({ ...settings, launchOnStartup: checked })} />}
              />
              <SettingRow
                label="Widget-First Startup"
                detail="On login launches, show only the widget and keep the desktop window hidden."
                control={
                  <div className={!settings.launchOnStartup ? "pointer-events-none opacity-50" : ""}>
                    <Switch
                      checked={settings.widgetOnlyOnStartup}
                      onChange={(checked) => void saveSettings({ ...settings, widgetOnlyOnStartup: checked })}
                    />
                  </div>
                }
              />
            </div>
          </div>

          <div className="flex flex-col">
            <SectionHeading title="OpenClaw And LLM Runtime" detail="Aura manages one shared runtime for every signed-in user on this device." />
            <div className="mt-5 space-y-4">
              <div className="rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-5">
                <p className="mb-4 text-sm leading-7 text-aura-muted">
                  This setup is fixed by Aura by default so users can sign in and start automating immediately.
                  Advanced Mode unlocks OpenClaw-first controls, fallback policy, and gateway overrides.
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Runtime Mode</span>
                    <select
                      value={selectedProvider}
                      disabled={!runtimeEditingEnabled || isSavingRuntime}
                      onChange={(event) => {
                        const nextProvider = event.target.value as EditableProvider;
                        setSelectedProvider(nextProvider);
                      }}
                      className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                    >
                      {PROVIDER_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-aura-muted">{selectedProviderMeta.detail}</p>
                  </label>

                  <label className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Model</span>
                    <input
                      value={runtimeEditingEnabled ? model : runtimeModelLabel}
                      readOnly={!runtimeEditingEnabled}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder={DEFAULT_MODELS[selectedProvider] || "Use provider default"}
                      className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                    />
                    <p className="text-xs text-aura-muted">
                      {runtimeEditingEnabled
                        ? "Override the default model for the selected provider."
                        : "Turn on Advanced Mode to edit the shared automation model."}
                    </p>
                  </label>

                  <label className="space-y-2 md:col-span-2">
                    <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Direct Provider Access</span>
                    <input
                      type="password"
                      value={selectedKey}
                      disabled={!runtimeEditingEnabled || !isDirectProvider(selectedProvider)}
                      onChange={(event) =>
                        setProviderKeys((current) => ({ ...current, [selectedProvider]: event.target.value }))
                      }
                      placeholder={runtimeEditingEnabled ? "Optional provider API key" : "Managed by Aura"}
                      className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-60" : ""}`}
                    />
                    <p className="text-xs text-aura-muted">
                      Direct keys stay available as optional fallbacks unless strict OpenClaw mode is enabled.
                    </p>
                  </label>
                </div>
              </div>

              <div className="rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-5">
                <div className="grid gap-4">
                  <label className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">OpenClaw Gateway URL</span>
                    <input
                      value={gatewayUrl}
                      readOnly={!runtimeEditingEnabled}
                      onChange={(event) => setGatewayUrl(event.target.value)}
                      placeholder="ws://127.0.0.1:18789"
                      className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                    />
                  </label>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Gateway Token</span>
                      <input
                        type="password"
                        value={gatewayToken}
                        readOnly={!runtimeEditingEnabled}
                        onChange={(event) => setGatewayToken(event.target.value)}
                        placeholder="OpenClaw auth token"
                        className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                      />
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Session Key</span>
                      <input
                        value={sessionKey}
                        readOnly={!runtimeEditingEnabled}
                        onChange={(event) => setSessionKey(event.target.value)}
                        placeholder="agent:main:main"
                        className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                      />
                    </label>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Automation Policy</span>
                      <select
                        value={automationPolicyTier}
                        disabled={!runtimeEditingEnabled || isSavingRuntime}
                        onChange={(event) => setAutomationPolicyTier(event.target.value as AutomationPolicyTier)}
                        className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                      >
                        <option value="safe_auto">Safe Auto</option>
                        <option value="confirm">Confirm</option>
                        <option value="locked">Locked</option>
                      </select>
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Max Step Retries</span>
                      <input
                        type="number"
                        min={1}
                        max={8}
                        value={maxStepRetries}
                        readOnly={!runtimeEditingEnabled}
                        onChange={(event) => setMaxStepRetries(Math.min(8, Math.max(1, Number(event.target.value) || 1)))}
                        className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                      />
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">WS Protocol Version</span>
                      <input
                        value={wsProtocolVersion}
                        readOnly={!runtimeEditingEnabled}
                        onChange={(event) => setWsProtocolVersion(event.target.value)}
                        placeholder="2026-04-06"
                        className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                      />
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Event Replay Limit</span>
                      <input
                        type="number"
                        min={100}
                        max={5000}
                        value={eventReplayLimit}
                        readOnly={!runtimeEditingEnabled}
                        onChange={(event) => setEventReplayLimit(Math.min(5000, Math.max(100, Number(event.target.value) || 100)))}
                        className={`${FIELD_CLASS} ${!runtimeEditingEnabled ? "cursor-not-allowed opacity-70" : ""}`}
                      />
                      </label>
                    </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <SettingRow
                      label="Strict OpenClaw Runtime"
                      detail="Require the OpenClaw gateway for automation so browser and desktop work stays on the gateway-backed workflow."
                      control={
                        <div className={!runtimeEditingEnabled ? "pointer-events-none opacity-60" : ""}>
                          <Switch
                            checked={automationPrimaryStrict}
                            onChange={(checked) => {
                              setAutomationPrimaryStrict(checked);
                              if (checked) {
                                setDisableLocalFallback(true);
                              }
                            }}
                          />
                        </div>
                      }
                    />
                    <SettingRow
                      label="Disable Local Fallback"
                      detail={openClawBoundMode
                        ? "Locked on while strict OpenClaw runtime is enabled so local browser and desktop actions cannot take over."
                        : "Block Aura local browser/desktop fallback when the OpenClaw gateway refuses or disconnects."}
                      control={
                        <div className={!runtimeEditingEnabled || openClawBoundMode ? "pointer-events-none opacity-60" : ""}>
                          <Switch
                            checked={openClawBoundMode || disableLocalFallback}
                            onChange={(checked) => setDisableLocalFallback(checked)}
                          />
                        </div>
                      }
                    />
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      className="rounded-[14px] bg-aura-gradient px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_4px_16px_rgba(124,58,237,0.3)] transition-all hover:shadow-[0_6px_24px_rgba(124,58,237,0.4)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={!runtimeEditingEnabled || isSavingRuntime}
                      onClick={() => void saveRuntimeConfig()}
                    >
                      Save Runtime Controls
                    </button>
                    <button
                      className="rounded-[14px] border border-white/[0.08] bg-white/[0.04] px-5 py-2.5 text-[13px] font-semibold text-aura-text transition-all hover:bg-white/[0.08] hover:border-white/[0.14] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isSavingRuntime}
                      onClick={() => void restartRuntime()}
                    >
                      Restart Runtime
                    </button>
                  </div>

                  {runtimeNotice && (
                    <p className="text-sm text-aura-muted">{runtimeNotice}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col">
            <SectionHeading title="Runtime Health" detail="Live state of the OpenClaw bridge, saved provider posture, and desktop permissions." />
            <div className="mt-5 space-y-4">
              <div className="group rounded-[20px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-5 transition-all hover:border-white/[0.1]">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${runtimeStatus.phase === "ready" ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" : "bg-amber-400 animate-pulse"}`} />
                  <p className="text-[13px] font-bold text-aura-text">Local Runtime</p>
                </div>
                <p className="mt-2 text-[13px] text-aura-muted">{runtimeStatus.message}</p>
                <p className="mt-2 text-[11px] text-aura-muted/70">
                  Phase: {runtimeStatus.phase} | Workspace: {runtimeStatus.workspacePath || "pending"}
                </p>
              </div>

              <div className="rounded-[20px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-5">
                <p className="text-[13px] font-bold text-aura-text">Provider Readiness</p>
                <div className="mt-3 space-y-2">
                  {providers.map((provider) => (
                    <div key={provider.id} className="flex items-center justify-between gap-4 rounded-[14px] border border-white/[0.04] bg-black/15 px-3.5 py-3">
                      <div>
                        <p className="text-sm text-aura-text">{provider.name}</p>
                        <p className="text-xs text-aura-muted">
                          {provider.model || "Using provider default"}
                        </p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        provider.configured
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-white/10 text-aura-muted"
                      }`}
                      >
                        {provider.managed ? "Managed" : provider.configured ? "Configured" : "Missing"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[20px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-5">
                <p className="text-[13px] font-bold text-aura-text">Permissions</p>
                <div className="mt-3 space-y-2">
                  {permissions.map((permission) => (
                    <label key={permission.id} className="flex items-center justify-between gap-4 rounded-[14px] border border-white/[0.04] bg-black/15 px-3.5 py-3">
                      <div>
                        <p className="text-sm text-aura-text">{permission.label}</p>
                        <p className="text-xs text-aura-muted">{permission.description}</p>
                      </div>
                      <select
                        value={permission.status}
                        onChange={(event) =>
                          void savePermissions(
                            permissions.map((entry) =>
                              entry.id === permission.id
                                ? { ...entry, status: event.target.value as PermissionState["status"] }
                                : entry,
                            ),
                          )
                        }
                        className={FIELD_CLASS}
                      >
                        <option value="prompt">Prompt</option>
                        <option value="granted">Granted</option>
                        <option value="denied">Denied</option>
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              <div className="rounded-[20px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-5">
                <p className="text-[13px] font-bold text-aura-text">Environment Snapshot</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-[14px] border border-white/[0.04] bg-black/15 px-3.5 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Backend</p>
                    <p className="mt-2 text-sm text-aura-text">{desktopEnv.openClawUrl || "Not configured"}</p>
                  </div>
                  <div className="rounded-[14px] border border-white/[0.04] bg-black/15 px-3.5 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Renderer LLM</p>
                    <p className="mt-2 text-sm text-aura-text">{desktopEnv.llmProvider} / {desktopEnv.llmModel}</p>
                    <p className="mt-1 text-xs text-aura-muted">API key: {desktopEnv.hasLlmApiKey ? "configured" : "missing"}</p>
                  </div>
                  <div className="rounded-[14px] border border-white/[0.04] bg-black/15 px-3.5 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Firebase</p>
                    <p className="mt-2 text-sm text-aura-text">{desktopEnv.firebaseProjectId || "Not configured"}</p>
                    <p className="mt-1 text-xs text-aura-muted">{desktopEnv.firebaseAuthDomain || "Auth domain missing"}</p>
                  </div>
                  <div className="rounded-[14px] border border-white/[0.04] bg-black/15 px-3.5 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Voice</p>
                    <p className="mt-2 text-sm text-aura-text">{desktopEnv.voiceProvider}</p>
                    <p className="mt-1 text-xs text-aura-muted">
                      Deepgram: {desktopEnv.hasDeepgramApiKey ? "configured" : "missing"} | Google: {desktopEnv.hasGoogleClientId ? "configured" : "missing"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

function hydrateRuntimeEditor(
  config: OpenClawConfig,
  providerInfo: ProviderInfo[],
  setters: {
    setProviders: (providers: ProviderInfo[]) => void;
    setSelectedProvider: (provider: EditableProvider) => void;
    setModel: (model: string) => void;
    setProviderKeys: (keys: Record<string, string>) => void;
    setGatewayUrl: (url: string) => void;
    setGatewayToken: (token: string) => void;
    setSessionKey: (sessionKey: string) => void;
    setAutomationPrimaryStrict: (value: boolean) => void;
    setDisableLocalFallback: (value: boolean) => void;
    setAutomationPolicyTier: (value: AutomationPolicyTier) => void;
    setMaxStepRetries: (value: number) => void;
    setWsProtocolVersion: (value: string) => void;
    setEventReplayLimit: (value: number) => void;
  },
): void {
  const storedProvider = String(config.agents?.main?.provider || "").trim().toLowerCase();
  const nextProvider = (PROVIDER_OPTIONS.some((option) => option.id === storedProvider)
    ? storedProvider
    : "auto") as EditableProvider;

  setters.setProviders(providerInfo);
  setters.setSelectedProvider(nextProvider);
  setters.setModel(config.agents?.main?.model || "");
  setters.setProviderKeys(
    Object.fromEntries(
      Object.entries(config.providers ?? {}).map(([providerId, providerConfig]) => [
        providerId,
        typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey : "",
      ]),
    ),
  );
  setters.setGatewayUrl(config.gateway?.url || DEFAULT_GATEWAY_URL);
  setters.setGatewayToken(config.gateway?.auth?.token || "");
  setters.setSessionKey(config.agents?.main?.sessionKey || "agent:main:main");
  setters.setAutomationPrimaryStrict(Boolean(config.automation?.primaryStrict));
  setters.setDisableLocalFallback(Boolean(config.automation?.disableLocalFallback));
  setters.setAutomationPolicyTier((config.automation?.policyTier || "safe_auto") as AutomationPolicyTier);
  setters.setMaxStepRetries(config.automation?.maxStepRetries || 3);
  setters.setWsProtocolVersion(config.automation?.wsProtocolVersion || "2026-04-06");
  setters.setEventReplayLimit(config.automation?.eventReplayLimit || 500);
}
