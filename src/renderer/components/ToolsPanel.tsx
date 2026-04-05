import { useState, useEffect } from "react";
import { useAuraStore } from "@renderer/store/useAuraStore";
import type { AuraMacro, PageMonitor, AutomationJob, SkillSummary, ToolsSubTab } from "@shared/types";
import { AuraLogoBlob } from "@renderer/components/primitives";

/* ─── Icons ───────────────────────────────────────────────────────── */
const MonitorIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

const MacroIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 11a9 9 0 0 1 9 9" />
    <path d="M4 4a16 16 0 0 1 16 16" />
    <circle cx="5" cy="19" r="1" />
  </svg>
);

const QuickIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const TABS: { id: ToolsSubTab; label: string; icon: JSX.Element }[] = [
  { id: "quick", label: "Skills", icon: <QuickIcon /> },
  { id: "monitors", label: "Monitors", icon: <MonitorIcon /> },
  { id: "macros", label: "Macros", icon: <MacroIcon /> },
];

/* ─── Main Component ──────────────────────────────────────────────── */
export const ToolsPanel = (): JSX.Element => {
  const [activeTab, setActiveTab] = useState<ToolsSubTab>("quick");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  
  const monitors = useAuraStore((s) => s.monitors);
  const macros = useAuraStore((s) => s.macros);
  const sendMessage = useAuraStore((s) => s.sendMessage);
  const setInputValue = useAuraStore((s) => s.setInputValue);

  useEffect(() => {
    if (activeTab === "quick" && skills.length === 0) {
      window.auraDesktop?.skills?.list().then(setSkills).catch(console.error);
    }
  }, [activeTab, skills.length]);

  // Group quick skills
  const availableSkills = skills;

  const handleQuickSkill = (skill: SkillSummary) => {
    // Quickly preload a skill command for the user in the main widget state
    setInputValue(`@${skill.name} `);
    // Ideally switch them back to 'chat' tab if possible in parent, but input value update is enough
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 fade-up">
      {/* Sub-tab Navigation */}
      <div className="flex gap-1.5 mb-3 px-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold tracking-wide transition-all duration-200 active:scale-[0.96] ${
              activeTab === t.id
                ? "bg-[#35235d] text-[#bca5ff] shadow-inner border border-[#bca5ff]/20"
                : "bg-white/5 text-aura-muted hover:bg-white/10 hover:text-aura-text border border-transparent"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Main List Area */}
      <div className="custom-scroll flex-1 min-h-0 overflow-y-auto pr-1 space-y-1">
        
        {/* SKILLS TAB */}
        {activeTab === "quick" && (
          availableSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-16">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
                <QuickIcon />
              </div>
              <div>
                <p className="text-sm font-medium text-aura-muted">No skills found</p>
                <p className="text-xs text-white/30 mt-1">Make sure OpenClaw skills are installed</p>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#bca5ff]/60 px-2 pt-2 mb-2">Available Skills</p>
              {availableSkills.map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => handleQuickSkill(skill)}
                  className="group flex w-full items-start gap-3 rounded-[16px] px-3 py-3 text-left transition-all duration-200 hover:bg-white/[0.04] active:scale-[0.98]"
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400">
                    <QuickIcon />
                  </div>
                  <div className="flex-1 min-w-0 pr-1">
                    <p className="truncate text-[13px] font-medium text-aura-text leading-tight mb-0.5">
                      {skill.name}
                    </p>
                    <p className="line-clamp-2 text-[11px] text-aura-muted leading-snug">
                      {skill.description || "A standard automation skill."}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )
        )}

        {/* MONITORS TAB */}
        {activeTab === "monitors" && (
          monitors.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-16">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
                <MonitorIcon />
              </div>
              <div>
                <p className="text-sm font-medium text-aura-muted">No monitors running</p>
                <p className="text-xs text-white/30 mt-1">Set up page tracking in the main app</p>
              </div>
            </div>
          ) : (
            <div className="space-y-1 mt-1">
              {monitors.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-[16px] px-3 py-3 bg-white/[0.02] border border-white/5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                      <MonitorIcon />
                    </div>
                    <div>
                      <p className="text-[13px] font-medium text-aura-text truncate max-w-[150px]">{m.title}</p>
                      <p className="text-[10px] uppercase font-semibold tracking-wider text-emerald-500/70 mt-1">{m.status}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                     <span className="text-[10px] text-white/30 truncate max-w-[80px]">{m.url ? new URL(m.url).hostname : "Manual"}</span>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* MACROS TAB */}
        {activeTab === "macros" && (
          macros.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-16">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
                <MacroIcon />
              </div>
              <div>
                <p className="text-sm font-medium text-aura-muted">No text macros</p>
                <p className="text-xs text-white/30 mt-1">Create shortcuts in Settings</p>
              </div>
            </div>
          ) : (
            <div className="space-y-1 mt-1">
              {macros.map((m) => (
                <div key={m.id} className="group overflow-hidden rounded-[16px] bg-white/[0.02] border border-white/5 transition-all">
                  <div className="px-3 py-3 flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono text-[#bca5ff] bg-[#35235d]/40 px-2 py-0.5 rounded-md">
                        {m.trigger}
                      </span>
                      <span className="text-[11px] text-aura-muted truncate ml-2">
                        {m.description}
                      </span>
                    </div>
                    <p className="text-[12px] text-aura-text/80 leading-snug line-clamp-2 mt-1">
                      {m.expansion}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

      </div>
    </div>
  );
};
