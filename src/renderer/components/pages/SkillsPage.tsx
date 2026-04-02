import { useEffect, useMemo, useState } from "react";

import { useAuraStore } from "@renderer/store/useAuraStore";

import { Card, SectionHeading, TextInput } from "../shared";
import { StatusPill } from "../primitives";

const categorizeSkill = (id: string, name: string): string => {
  const haystack = `${id} ${name}`.toLowerCase();
  if (/(gmail|mail|outlook|slack|whatsapp|telegram|discord|message|calendar|meet|drive)/.test(haystack)) {
    return "Communication";
  }
  if (/(github|code|dev|terminal|shell|build|deploy)/.test(haystack)) {
    return "Development";
  }
  if (/(browser|web|search|scrape|research)/.test(haystack)) {
    return "Web";
  }
  if (/(image|video|audio|voice|design|caption)/.test(haystack)) {
    return "Media";
  }
  return "General";
};

export const SkillsPage = (): JSX.Element => {
  const skills = useAuraStore((state) => state.skills);
  const loadSkills = useAuraStore((state) => state.loadSkills);
  const setRoute = useAuraStore((state) => state.setRoute);
  const setInputValue = useAuraStore((state) => state.setInputValue);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) =>
      `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(normalized)
    );
  }, [query, skills]);

  const groups = useMemo(() => {
    const mapped = new Map<string, typeof filtered>();
    for (const skill of filtered) {
      const category = categorizeSkill(skill.id, skill.name);
      const existing = mapped.get(category) ?? [];
      mapped.set(category, [...existing, skill]);
    }
    return [...mapped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1400px] flex-col overflow-y-auto pr-2 pb-8 mt-2">
      <Card className="bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.16),transparent_40%),rgba(26,25,38,0.66)]">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-aura-muted">Skill Catalog</p>
            <h1 className="mt-3 text-[30px] font-bold tracking-tight text-aura-text">Bundled OpenClaw capabilities</h1>
            <p className="mt-2 max-w-[760px] text-[14px] leading-7 text-aura-muted">
              Browse packaged OpenClaw skills by category, then launch straight into chat with a ready-made prompt seed
              instead of exposing raw skill files or setup complexity.
            </p>
          </div>

          <div className="w-full max-w-[360px]">
            <TextInput value={query} onChange={setQuery} placeholder="Search skills, apps, or categories" />
          </div>
        </div>
      </Card>

      <div className="mt-8 space-y-8">
        <SectionHeading
          title="Available Skills"
          detail={`${filtered.length} visible skills across ${groups.length} categories.`}
        />

        {groups.length === 0 ? (
          <Card>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
              </div>
              <p className="mt-4 text-[15px] font-semibold text-aura-text">No matching skills</p>
              <p className="mt-2 text-[13px] leading-7 text-aura-muted">Try a broader query like “mail”, “browser”, or “calendar”.</p>
            </div>
          </Card>
        ) : (
          groups.map(([category, categorySkills]) => (
            <div key={category}>
              <div className="mb-4 flex items-center justify-between">
                <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-aura-muted">{category}</p>
                <p className="text-xs text-aura-muted">{categorySkills.length} skills</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {categorySkills.map((skill) => (
                  <Card key={skill.id} className="rounded-[28px] p-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] bg-white/5 text-aura-violet">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                        </div>
                        <div>
                          <p className="text-[16px] font-bold tracking-tight text-aura-text">{skill.name}</p>
                          <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-aura-violet">{skill.id}</p>
                        </div>
                      </div>
                      <StatusPill label={skill.enabled ? "Ready" : "Disabled"} tone={skill.enabled ? "success" : "default"} />
                    </div>

                    <p className="mt-5 min-h-[72px] text-[14px] leading-7 text-aura-muted">{skill.description}</p>

                    <div className="mt-5 flex items-center justify-between gap-3">
                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-aura-muted">
                        {category}
                      </span>
                      <button
                        className="rounded-[14px] border border-aura-violet/30 bg-aura-violet/10 px-4 py-2 text-xs font-semibold text-aura-violet transition hover:bg-aura-violet/20"
                        onClick={() => {
                          setInputValue(`Use the ${skill.name} skill to `);
                          void setRoute("home");
                        }}
                      >
                        Launch In Chat
                      </button>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
