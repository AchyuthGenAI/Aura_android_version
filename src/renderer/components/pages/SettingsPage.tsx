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

import { RuntimeRecoveryBanner } from "../RuntimeRecoveryBanner";
import { SectionHeading, SettingRow, Switch } from "../shared";

type EditableProvider = "auto" | "openclaw" | "groq" | "openai" | "openrouter" | "google" | "anthropic";
type DirectProvider = Exclude<EditableProvider, "auto" | "openclaw">;

const PROVIDER_OPTIONS: Array<{ id: EditableProvider; label: string; detail: string }> = [
  { id: "auto", label: "Auto", detail: "Prefer OpenClaw when connected, otherwise use the best configured direct model." },
  { id: "openclaw", label: "OpenClaw", detail: "Use the OpenClaw gateway for agent-style chat and keep direct LLMs as planner fallback." },
  { id: "groq", label: "Groq", detail: "Fast direct model routing with Aura's managed fallback." },
  { id: "openai", label: "OpenAI", detail: "Route direct chat and planning through OpenAI." },
  { id: "openrouter", label: "OpenRouter", detail: "Use an OpenRouter model with your own key." },
  { id: "google", label: "Google Gemini", detail: "Use Gemini for direct planning, chat, and monitor evaluation." },
  { id: "anthropic", label: "Anthropic", detail: "Use Claude for direct planning and chat." },
];

const DEFAULT_MODELS: Record<EditableProvider, string> = {
  auto: "",
  openclaw: "",
  groq: "llama-3.3-70b-versatile",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
  google: "gemini-2.0-flash",
  anthropic: "claude-3-5-haiku-latest",
};
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

const FIELD_CLASS =
  "w-full rounded-[16px] border border-white/[0.08] bg-black/20 px-3 py-2.5 text-sm text-aura-text outline-none transition focus:border-aura-violet/50";

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
    || (selectedProvider === "openclaw" ? "Aura-managed Gemini fallback" : DEFAULT_MODELS[selectedProvider] || "Provider default");
  const managedGatewayUrl = gatewayUrl || `ws://127.0.0.1:${runtimeStatus.port || 18789}`;
  const configuredManagedProviders = providers.filter((provider) => provider.configured);
  const managedProviderSummary = configuredManagedProviders.length
    ? configuredManagedProviders.map((provider) => provider.name).join(", ")
    : "No managed provider keys configured";
  const managedProviderKeyState = configuredManagedProviders.length ? "configured" : "missing";

  const saveRuntimeConfig = async (): Promise<void> => {
    setIsSavingRuntime(true);
    setRuntimeNotice(null);

    try {
      // Update agent model via current API
      if (model.trim()) {
        await window.auraDesktop.config.setModel({
          model: model.trim(),
          provider: selectedProvider === "auto" || selectedProvider === "openclaw" ? undefined : selectedProvider,
        });
      }

      if (isDirectProvider(selectedProvider)) {
        await window.auraDesktop.config.setApiKey({
          provider: selectedProvider,
          apiKey: selectedKey.trim(),
        });
      }

      // Gateway URL and token are managed by the runtime; no setGateway API.

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
      <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_minmax(360px,430px)]">
        <div className="flex flex-col gap-12">
          <div className="flex flex-col">
            <SectionHeading title="Desktop Preferences" detail="Tune the shell behavior, privacy posture, and startup experience." />
            <div className="mt-5 grid gap-4 xl:grid-cols-2">
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
              <div className="rounded-[24px] border border-white/8 bg-white/5 p-5">
                <p className="mb-4 text-sm leading-7 text-aura-muted">
                  This setup is fixed by Aura so users can sign in and start automating immediately without a separate LLM or gateway setup step.
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Runtime Mode</span>
                    <select
                      value={selectedProvider}
                      disabled
                      className={`${FIELD_CLASS} cursor-not-allowed opacity-70`}
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
                      value={runtimeModelLabel}
                      readOnly
                      placeholder={DEFAULT_MODELS[selectedProvider] || "Use provider default"}
                      className={`${FIELD_CLASS} cursor-not-allowed opacity-70`}
                    />
                    <p className="text-xs text-aura-muted">Aura keeps the shared automation model fixed for every account.</p>
                  </label>

                  <label className="space-y-2 md:col-span-2">
                    <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Direct Provider Access</span>
                    <input
                      type="password"
                      value={selectedKey}
                      disabled
                      placeholder="Managed by Aura"
                      className={`${FIELD_CLASS} cursor-not-allowed opacity-60`}
                    />
                    <p className="text-xs text-aura-muted">
                      Aura handles fallback provider access behind the scenes so signed-in users do not need to configure keys manually.
                    </p>
                  </label>
                </div>
              </div>

              <div className="rounded-[24px] border border-white/8 bg-white/5 p-5">
                <div className="grid gap-4">
                  <label className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">OpenClaw Gateway URL</span>
                    <input
                      value={gatewayUrl}
                      readOnly
                      placeholder="ws://127.0.0.1:18789"
                      className={`${FIELD_CLASS} cursor-not-allowed opacity-70`}
                    />
                  </label>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Gateway Token</span>
                      <input
                        type="password"
                        value={gatewayToken}
                        readOnly
                        placeholder="OpenClaw auth token"
                        className={`${FIELD_CLASS} cursor-not-allowed opacity-70`}
                      />
                    </label>
                    <label className="space-y-2">
                      <span className="text-xs uppercase tracking-[0.18em] text-aura-muted">Session Key</span>
                      <input
                        value={sessionKey}
                        readOnly
                        placeholder="agent:main:main"
                        className={`${FIELD_CLASS} cursor-not-allowed opacity-70`}
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      className="rounded-[16px] border border-white/10 bg-white/6 px-4 py-2.5 text-sm font-medium text-aura-text transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
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
              <RuntimeRecoveryBanner
                primaryAction={{
                  label: "Restart Runtime",
                  onClick: () => restartRuntime(),
                }}
              />

              <div className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                <p className="text-sm font-semibold text-aura-text">Local Runtime</p>
                <p className="mt-1 text-sm text-aura-muted">{runtimeStatus.message}</p>
                <p className="mt-2 text-xs text-aura-muted">
                  Phase: {runtimeStatus.phase} | Workspace: {runtimeStatus.workspacePath || "pending"}
                </p>
                {runtimeStatus.diagnostics?.supportNote && (
                  <p className="mt-2 text-xs leading-5 text-aura-muted">{runtimeStatus.diagnostics.supportNote}</p>
                )}
              </div>

              <div className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                <p className="text-sm font-semibold text-aura-text">Provider Readiness</p>
                <div className="mt-3 space-y-2">
                  {providers.map((provider) => (
                    <div key={provider.id} className="flex items-center justify-between gap-4 rounded-2xl bg-black/10 px-3 py-3">
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

              <div className="rounded-[24px] border border-white/8 bg-white/5 p-4">
                <p className="text-sm font-semibold text-aura-text">Permissions</p>
                <div className="mt-3 space-y-2">
                  {permissions.map((permission) => (
                    <label key={permission.id} className="flex items-center justify-between gap-4 rounded-2xl bg-black/10 px-3 py-3">
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

              <div className="rounded-[24px] border border-white/[0.08] bg-[#1a1926]/50 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.24)] backdrop-blur-3xl">
                <p className="text-sm font-semibold text-aura-text">Environment Snapshot</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-black/10 px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Backend</p>
                    <p className="mt-2 text-sm text-aura-text">{managedGatewayUrl}</p>
                    <p className="mt-1 text-xs text-aura-muted">Runtime phase: {runtimeStatus.phase}</p>
                  </div>
                  <div className="rounded-2xl bg-black/10 px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Managed Agent</p>
                    <p className="mt-2 text-sm text-aura-text">{selectedProviderMeta.label} / {runtimeModelLabel}</p>
                    <p className="mt-1 text-xs text-aura-muted">Managed keys: {managedProviderKeyState} ({managedProviderSummary})</p>
                  </div>
                  <div className="rounded-2xl bg-black/10 px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Firebase</p>
                    <p className="mt-2 text-sm text-aura-text">{desktopEnv.firebaseProjectId || "Not configured"}</p>
                    <p className="mt-1 text-xs text-aura-muted">{desktopEnv.firebaseAuthDomain || "Auth domain missing"}</p>
                  </div>
                  <div className="rounded-2xl bg-black/10 px-3 py-3">
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
  setters.setGatewayUrl(`ws://127.0.0.1:${config.gateway?.port || 18789}`);
  setters.setGatewayToken(config.gateway?.auth?.token || "");
  setters.setSessionKey((config.agents?.main as Record<string, unknown> | undefined)?.sessionKey as string || "agent:main:main");
}
