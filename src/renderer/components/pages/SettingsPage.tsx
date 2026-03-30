import type { AuraSettings, PermissionState, ThemeMode } from "@shared/types";

import { desktopEnv } from "@renderer/config/env";
import { SectionHeading, SettingRow, Switch } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

export const SettingsPage = (): JSX.Element => {
  const settings = useAuraStore((state) => state.settings);
  const permissions = useAuraStore((state) => state.permissions);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const saveSettings = useAuraStore((state) => state.saveSettings);
  const savePermissions = useAuraStore((state) => state.savePermissions);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1200px] flex-col overflow-y-auto pr-2 pb-8 mt-2">
      <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <div className="flex flex-col">
          <SectionHeading title="Managed AI Access" detail="The desktop wrapper owns local runtime setup and provider posture." />
          <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <SettingRow
            label="Theme"
            detail="Switch the desktop shell between dark and light."
            control={
              <select
                value={settings.theme}
                onChange={(event) => void saveSettings({ ...settings, theme: event.target.value as ThemeMode })}
                className="rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-2 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50"
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
                className="rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-2 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50"
              >
                <option value="standard">Standard</option>
                <option value="strict">Strict</option>
              </select>
            }
          />
          <SettingRow
            label="Voice Mode"
            detail="Enable voice interaction for Aura sessions."
            control={
              <Switch
                checked={settings.voiceEnabled}
                onChange={(checked) => void saveSettings({ ...settings, voiceEnabled: checked })}
              />
            }
          />
          <SettingRow
            label="Advanced Mode"
            detail="Expose more power-user behaviors in the desktop app."
            control={
              <Switch
                checked={settings.advancedMode}
                onChange={(checked) => void saveSettings({ ...settings, advancedMode: checked })}
              />
            }
          />
          <SettingRow
            label="Launch On Startup"
            detail="Start Aura automatically when you sign into Windows."
            control={
              <Switch
                checked={settings.launchOnStartup}
                onChange={(checked) => void saveSettings({ ...settings, launchOnStartup: checked })}
              />
            }
          />
          <SettingRow
            label="Widget-First Startup"
            detail="On login launches, show only the widget and keep the desktop window hidden."
            control={
              <div className={!settings.launchOnStartup ? "opacity-50 pointer-events-none" : ""}>
                <Switch
                  checked={settings.widgetOnlyOnStartup}
                  onChange={(checked) => void saveSettings({ ...settings, widgetOnlyOnStartup: checked })}
                />
              </div>
            }
          />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col">
          <SectionHeading title="Runtime Health" detail="No raw keys by default. Aura manages the local runtime state for the user." />
          <div className="mt-5 space-y-4">
            <div className="rounded-[24px] border border-white/8 bg-white/5 p-4">
              <p className="text-sm font-semibold text-aura-text">Local OpenClaw</p>
              <p className="mt-1 text-sm text-aura-muted">{runtimeStatus.message}</p>
              <p className="mt-2 text-xs text-aura-muted">
                Phase: {runtimeStatus.phase} | Workspace: {runtimeStatus.workspacePath || "pending"}
              </p>
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
                              : entry
                          )
                        )
                      }
                      className="rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-2 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50"
                    >
                      <option value="prompt">Prompt</option>
                      <option value="granted">Granted</option>
                      <option value="denied">Denied</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] border border-white/[0.08] bg-[#1a1926]/50 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.24)] backdrop-blur-3xl shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <p className="text-sm font-semibold text-aura-text">Environment</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Backend</p>
                  <p className="mt-2 text-sm text-aura-text">{desktopEnv.openClawUrl || "Not configured"}</p>
                </div>
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">LLM</p>
                  <p className="mt-2 text-sm text-aura-text">
                    {desktopEnv.llmProvider} / {desktopEnv.llmModel}
                  </p>
                  <p className="mt-1 text-xs text-aura-muted">
                    API key: {desktopEnv.hasLlmApiKey ? "configured" : "missing"}
                  </p>
                </div>
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Firebase</p>
                  <p className="mt-2 text-sm text-aura-text">{desktopEnv.firebaseProjectId || "Not configured"}</p>
                  <p className="mt-1 text-xs text-aura-muted">
                    {desktopEnv.firebaseAuthDomain || "Auth domain missing"}
                  </p>
                </div>
                <div className="rounded-2xl bg-black/10 px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">Voice</p>
                  <p className="mt-2 text-sm text-aura-text">{desktopEnv.voiceProvider}</p>
                  <p className="mt-1 text-xs text-aura-muted">
                    Deepgram: {desktopEnv.hasDeepgramApiKey ? "configured" : "missing"} | Google:{" "}
                    {desktopEnv.hasGoogleClientId ? "configured" : "missing"}
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
