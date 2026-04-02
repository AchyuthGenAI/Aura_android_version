import { useState } from "react";

import type { AuraSettings, PermissionState, ThemeMode } from "@shared/types";

import { useAuraStore } from "@renderer/store/useAuraStore";

import { Button, Card, SectionHeading, SettingRow, Switch } from "../shared";
import { StatusPill } from "../primitives";

const FIELD_CLASS =
  "rounded-[14px] border border-white/[0.06] bg-black/20 px-3 py-2 text-[13px] font-medium text-aura-text outline-none focus:border-aura-violet/50";

const statusTone = (phase: string): "default" | "success" | "warning" | "error" => {
  if (phase === "ready") return "success";
  if (phase === "running" || phase === "starting" || phase === "checking") return "warning";
  if (phase === "error" || phase === "install-required") return "error";
  return "default";
};

export const SettingsPage = (): JSX.Element => {
  const settings = useAuraStore((state) => state.settings);
  const permissions = useAuraStore((state) => state.permissions);
  const runtimeStatus = useAuraStore((state) => state.runtimeStatus);
  const saveSettings = useAuraStore((state) => state.saveSettings);
  const savePermissions = useAuraStore((state) => state.savePermissions);
  const [isRestarting, setIsRestarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleRestart = async (): Promise<void> => {
    setIsRestarting(true);
    setNotice(null);
    try {
      await window.auraDesktop.runtime.restart();
      setNotice("Aura restarted the managed OpenClaw runtime and refreshed its health state.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not restart the managed runtime.");
    } finally {
      setIsRestarting(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1280px] flex-col overflow-y-auto pr-2 pb-8 mt-2">
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,420px)]">
        <div className="space-y-8">
          <Card className="bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.16),transparent_42%),rgba(26,25,38,0.72)]">
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-aura-muted">Managed Runtime</p>
                  <h1 className="mt-3 text-[30px] font-bold tracking-tight text-aura-text">OpenClaw-first desktop runtime</h1>
                  <p className="mt-2 max-w-[720px] text-[14px] leading-7 text-aura-muted">
                    Aura owns runtime bootstrap, gateway wiring, session identity, and bundled capability access. Users
                    get one managed control surface instead of provider, key, and model setup screens.
                  </p>
                </div>
                <StatusPill label={runtimeStatus.phase} tone={statusTone(runtimeStatus.phase)} />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <RuntimeMetric
                  label="Bundle"
                  value={runtimeStatus.bundleDetected || runtimeStatus.openClawDetected ? "Bundled" : "Missing"}
                  detail={runtimeStatus.diagnostics?.bundleRootPath || "OpenClaw package path pending"}
                />
                <RuntimeMetric
                  label="Gateway"
                  value={runtimeStatus.gatewayConnected ? "Connected" : runtimeStatus.degraded ? "Degraded" : "Pending"}
                  detail={runtimeStatus.diagnostics?.gatewayUrl || "Loopback gateway"}
                />
                <RuntimeMetric
                  label="Workspace"
                  value={runtimeStatus.workspacePath ? "Ready" : "Pending"}
                  detail={runtimeStatus.workspacePath || "Waiting for bootstrap"}
                />
              </div>

              <div className="rounded-[24px] border border-white/[0.08] bg-black/20 px-5 py-4">
                <p className="text-sm font-semibold text-aura-text">Runtime status</p>
                <p className="mt-2 text-sm leading-7 text-aura-muted">{runtimeStatus.message}</p>
                {runtimeStatus.error && (
                  <p className="mt-2 text-sm text-red-300">{runtimeStatus.error}</p>
                )}
                {notice && (
                  <p className="mt-3 text-sm text-aura-muted">{notice}</p>
                )}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button
                    className="bg-aura-gradient text-white"
                    onClick={() => void handleRestart()}
                    disabled={isRestarting}
                  >
                    {isRestarting ? "Restarting..." : "Restart Managed Runtime"}
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          <div>
            <SectionHeading title="Desktop Preferences" detail="Adjust shell behavior without exposing infrastructure settings to end users." />
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
                detail="Enable hands-free voice sessions that still use the same managed OpenClaw chat runtime."
                control={<Switch checked={settings.voiceEnabled} onChange={(checked) => void saveSettings({ ...settings, voiceEnabled: checked })} />}
              />
              <SettingRow
                label="Advanced Mode"
                detail="Reveal support-oriented shell details without turning runtime configuration into a user task."
                control={<Switch checked={settings.advancedMode} onChange={(checked) => void saveSettings({ ...settings, advancedMode: checked })} />}
              />
              <SettingRow
                label="Launch On Startup"
                detail="Start Aura when you sign into Windows."
                control={<Switch checked={settings.launchOnStartup} onChange={(checked) => void saveSettings({ ...settings, launchOnStartup: checked })} />}
              />
              <SettingRow
                label="Widget-First Startup"
                detail="Keep the desktop window hidden on login and bring up the floating shell first."
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
        </div>

        <div className="space-y-6">
          <Card>
            <SectionHeading title="Support Diagnostics" detail="Read-only details for support and packaging checks." />
            <div className="mt-5 space-y-3 text-sm text-aura-muted">
              <DiagnosticRow label="Managed mode" value={runtimeStatus.diagnostics?.managedMode || "openclaw-first"} />
              <DiagnosticRow label="Version" value={runtimeStatus.version || "Pending"} />
              <DiagnosticRow label="Gateway URL" value={runtimeStatus.diagnostics?.gatewayUrl || "ws://127.0.0.1:18789"} />
              <DiagnosticRow label="Gateway token" value={runtimeStatus.diagnostics?.gatewayTokenConfigured ? "Configured" : "Missing"} />
              <DiagnosticRow label="Session key" value={runtimeStatus.diagnostics?.sessionKey || "main"} />
              <DiagnosticRow label="Bundle root" value={runtimeStatus.diagnostics?.bundleRootPath || "Pending"} />
              <DiagnosticRow label="Workspace" value={runtimeStatus.workspacePath || "Pending"} />
              <DiagnosticRow label="Last check" value={runtimeStatus.lastCheckedAt ? new Date(runtimeStatus.lastCheckedAt).toLocaleString() : "Pending"} />
            </div>
          </Card>

          <Card>
            <SectionHeading title="Permissions" detail="Local access Aura may need for voice, alerts, and automation flows." />
            <div className="mt-5 space-y-3">
              {permissions.map((permission) => (
                <label key={permission.id} className="flex items-center justify-between gap-4 rounded-[20px] border border-white/[0.06] bg-black/10 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-aura-text">{permission.label}</p>
                    <p className="mt-1 text-xs leading-6 text-aura-muted">{permission.description}</p>
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
                    className={FIELD_CLASS}
                  >
                    <option value="prompt">Prompt</option>
                    <option value="granted">Granted</option>
                    <option value="denied">Denied</option>
                  </select>
                </label>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

const RuntimeMetric = ({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element => (
  <div className="rounded-[22px] border border-white/[0.06] bg-white/[0.03] px-4 py-4">
    <p className="text-[11px] uppercase tracking-[0.18em] text-aura-muted">{label}</p>
    <p className="mt-3 text-[26px] font-bold tracking-tight text-aura-text">{value}</p>
    <p className="mt-1 text-xs leading-6 text-aura-muted">{detail}</p>
  </div>
);

const DiagnosticRow = ({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element => (
  <div className="flex items-start justify-between gap-4 rounded-[18px] border border-white/[0.06] bg-black/10 px-4 py-3">
    <p className="text-xs uppercase tracking-[0.18em] text-aura-muted">{label}</p>
    <p className="text-right text-sm text-aura-text">{value}</p>
  </div>
);
