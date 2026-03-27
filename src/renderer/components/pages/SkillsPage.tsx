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
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">

      <Card className="flex min-h-0 flex-col px-5 py-5">
        <SectionHeading title="Available Skills" detail="Desktop-visible bundled OpenClaw skills without exposing raw config files." />
        <div className="mt-5 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1 md:grid-cols-2 2xl:grid-cols-3">
          {skills.map((skill) => (
            <div key={skill.id} className="group rounded-[28px] border border-white/[0.06] bg-white/[0.02] p-6 transition-all hover:bg-white/[0.04] hover:border-white/[0.1] hover:shadow-xl hover:shadow-aura-violet/5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[16px] font-bold tracking-tight text-aura-text transition-colors group-hover:text-white">{skill.name}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-aura-violet">{skill.id}</p>
                </div>
                <StatusPill label={skill.enabled ? "Enabled" : "Disabled"} tone={skill.enabled ? "success" : "default"} />
              </div>
              <p className="mt-4 text-[14px] leading-relaxed text-aura-muted line-clamp-3">{skill.description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};
