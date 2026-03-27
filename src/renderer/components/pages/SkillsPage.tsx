import { useEffect } from "react";

import { StatusPill } from "../primitives";
import { Card, InfoTile, SectionHeading } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

export const SkillsPage = (): JSX.Element => {
  const skills = useAuraStore((state) => state.skills);
  const loadSkills = useAuraStore((state) => state.loadSkills);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1400px] flex-col overflow-y-auto pr-2 pb-8 mt-2">

      <div className="flex flex-col">
        <SectionHeading title="Available Skills" detail="Desktop-visible bundled OpenClaw skills without exposing raw config files." />
        <div className="mt-5 grid flex-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {skills.map((skill) => (
            <div key={skill.id} className="group flex flex-col h-full rounded-[28px] border border-white/[0.06] bg-white/[0.02] p-6 transition-all duration-300 hover:-translate-y-1 hover:bg-white/[0.04] hover:border-white/[0.12] hover:shadow-xl hover:shadow-aura-violet/5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-white/5 text-aura-muted transition-colors group-hover:bg-aura-violet/10 group-hover:text-aura-violet">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  </div>
                  <div>
                    <p className="text-[16px] font-bold tracking-tight text-aura-text transition-colors group-hover:text-white">{skill.name}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-aura-violet">{skill.id}</p>
                  </div>
                </div>
                <StatusPill label={skill.enabled ? "Enabled" : "Disabled"} tone={skill.enabled ? "success" : "default"} />
              </div>
              <p className="mt-5 text-[14px] leading-relaxed text-aura-muted line-clamp-3">{skill.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
