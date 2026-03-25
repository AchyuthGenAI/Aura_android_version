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
      <Card className="px-6 py-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-[760px]">
            <p className="text-xs uppercase tracking-[0.3em] text-aura-violet">Skills Library</p>
            <h1 className="mt-3 text-[34px] font-semibold tracking-tight text-aura-text">Keep tools readable, discoverable, and ready to use.</h1>
            <p className="mt-3 text-sm leading-7 text-aura-muted">
              This view focuses on what each skill does and whether it is available, so the library feels browsable instead of dumping raw identifiers into a cramped grid.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoTile label="Total Skills" value={String(skills.length)} detail="Bundled desktop-visible skills." />
            <InfoTile
              label="Enabled"
              value={String(skills.filter((skill) => skill.enabled).length)}
              detail="Skills currently ready for use."
            />
          </div>
        </div>
      </Card>
      <Card className="flex min-h-0 flex-col px-5 py-5">
        <SectionHeading title="Available Skills" detail="Desktop-visible bundled OpenClaw skills without exposing raw config files." />
        <div className="mt-5 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1 md:grid-cols-2 2xl:grid-cols-3">
          {skills.map((skill) => (
            <div key={skill.id} className="rounded-[24px] border border-white/8 bg-white/5 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-aura-text">{skill.name}</p>
                  <p className="mt-1 text-[11px] uppercase tracking-[0.2em] text-aura-violet">{skill.id}</p>
                </div>
                <StatusPill label={skill.enabled ? "Enabled" : "Disabled"} tone={skill.enabled ? "success" : "default"} />
              </div>
              <p className="mt-4 text-sm leading-7 text-aura-muted">{skill.description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};
