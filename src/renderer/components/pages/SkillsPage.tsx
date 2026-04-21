import { useEffect, useMemo, useRef } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";
import type { SkillSummary } from "@shared/types";

import { StatusPill } from "../primitives";
import { SectionHeading, InfoTile } from "../shared";

const getReadinessTone = (readiness?: string): "default" | "success" | "warning" | "error" => {
  if (readiness === "ready") return "success";
  if (readiness === "needs_setup") return "warning";
  if (readiness === "unsupported" || readiness === "disabled") return "error";
  return "default";
};

const getReadinessLabel = (readiness?: string, browserBacked?: boolean, auraBacked?: boolean): string => {
  if (readiness === "ready" && browserBacked) return "Browser Ready";
  if (readiness === "ready" && auraBacked) return "Aura Ready";
  if (readiness === "needs_setup") return "Setup Needed";
  if (readiness === "unsupported") return "Unsupported";
  if (readiness === "disabled") return "Disabled";
  if (readiness === "ready") return "Ready";
  return "Available";
};

export const SkillsPage = (): JSX.Element => {
  const skills = useAuraStore((state) => state.skills);
  const loadSkills = useAuraStore((state) => state.loadSkills);
  const setRoute = useAuraStore((state) => state.setRoute);
  const setInputValue = useAuraStore((state) => state.setInputValue);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const readyCount = skills.filter((s) => s.readiness === "ready").length;
  const browserReadyCount = skills.filter((s) => s.readiness === "ready" && s.browserBacked).length;
  const setupCount = skills.filter((s) => s.readiness === "needs_setup").length;

  const groupedSkills = useMemo(() => {
    const groups: Record<string, SkillSummary[]> = {};
    for (const skill of skills) {
      const cat = skill.category || "Uncategorized";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(skill);
    }
    // Sort categories alphabetically
    return Object.keys(groups)
      .sort()
      .map((category) => ({
        category,
        items: groups[category].sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [skills]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToCategory = (category: string) => {
    const element = document.getElementById(`category-${category}`);
    if (element && scrollRef.current) {
      const topPos = element.offsetTop - 180; // Offset for sticky nav
      scrollRef.current.scrollTo({ top: topPos, behavior: "smooth" });
    }
  };

  return (
    <div ref={scrollRef} className="mx-auto mt-2 flex h-full w-full max-w-[1400px] flex-col overflow-y-auto pr-2 pb-8">
      <div className="flex flex-col">
        <SectionHeading
          title="Available Skills"
          detail="Bundled OpenClaw skills that Aura can auto-apply across chat, navigation, and task execution."
        />

        {/* Stats Row */}
        <div className="mt-4 grid gap-4 grid-cols-1 md:grid-cols-3">
          <InfoTile
            label="Total Ready"
            value={readyCount.toString()}
            detail={`Out of ${skills.length} available skills`}
          />
          <InfoTile
            label="Browser Backed"
            value={browserReadyCount.toString()}
            detail="Native web automation workflows"
          />
          <InfoTile
            label="Action Required"
            value={setupCount.toString()}
            detail="Require CLI, API key, or config setup"
          />
        </div>

        {/* Sticky Category Nav */}
        {groupedSkills.length > 0 && (
          <div className="sticky top-0 z-20 -mx-4 mt-8 mb-6 flex flex-wrap gap-2 bg-aura-bg/85 px-4 pb-4 pt-4 backdrop-blur-xl border-b border-white/[0.04]">
            {groupedSkills.map(({ category }) => (
              <button
                key={category}
                onClick={() => scrollToCategory(category)}
                className="rounded-full border border-white/5 bg-white/[0.03] px-4 py-1.5 text-[12px] font-semibold text-aura-muted transition-colors hover:bg-aura-violet/10 hover:text-aura-violet"
              >
                {category}
              </button>
            ))}
          </div>
        )}

        {/* Skills List Grouped by Category */}
        <div className="flex flex-col gap-10">
          {groupedSkills.map(({ category, items }) => (
            <div key={category} id={`category-${category}`} className="flex flex-col">
              <h3 className="mb-4 text-[13px] font-bold uppercase tracking-[0.15em] text-aura-muted">
                {category} <span className="opacity-60">({items.length})</span>
              </h3>
              
              <div className="grid flex-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {items.map((skill) => (
                  <div
                    key={skill.id}
                    className="group relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.05] bg-gradient-to-b from-white/[0.02] to-transparent p-6 transition-all duration-300 hover:-translate-y-1 hover:border-aura-violet/25 hover:shadow-[0_8px_30px_rgba(124,58,237,0.12)]"
                  >
                    <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-aura-violet/40 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                    
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-white/5 bg-white/5 text-aura-muted transition-colors group-hover:bg-aura-gradient group-hover:text-white group-hover:border-transparent">
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-[16px] font-bold tracking-tight text-aura-text transition-colors group-hover:text-white">
                            {skill.name}
                          </p>
                          <p className="mt-0.5 text-[11px] uppercase tracking-[0.15em] text-aura-violet/80">
                            {skill.id}
                          </p>
                        </div>
                      </div>
                      <StatusPill
                        label={getReadinessLabel(skill.readiness, skill.browserBacked, skill.auraBacked)}
                        tone={getReadinessTone(skill.readiness)}
                      />
                    </div>
                    
                    <p className="mt-5 flex-1 text-[13px] leading-[1.6] text-aura-muted opacity-90 line-clamp-3">
                      {skill.description}
                    </p>
                    
                    {skill.setupHint ? (
                      <div className="mt-4 rounded-[14px] border border-white/5 bg-black/20 p-3">
                        <p className="text-[11.5px] leading-relaxed text-aura-muted/90">
                          <span className="font-semibold text-aura-text/80">Hint:</span> {skill.setupHint}
                        </p>
                      </div>
                    ) : null}
                    
                    {skill.keywords && skill.keywords.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {skill.keywords.slice(0, 4).map((keyword) => (
                          <span
                            key={`${skill.id}-${keyword}`}
                            className="rounded-lg bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-aura-muted"
                          >
                            {keyword}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    
                    <div className="mt-5 pt-4 border-t border-white/[0.04]">
                      <button
                        className="flex w-full items-center justify-center gap-2 rounded-[14px] bg-aura-violet/10 px-4 py-2.5 text-[13px] font-semibold text-aura-violet transition-all duration-200 hover:bg-aura-violet hover:text-white"
                        onClick={() => {
                          setInputValue(`Use the ${skill.name} skill to help me `);
                          void setRoute("home");
                        }}
                      >
                        Use this skill
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="5" y1="12" x2="19" y2="12"></line>
                          <polyline points="12 5 19 12 12 19"></polyline>
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
