import { useEffect, useState } from "react";

import type { UserProfile } from "@shared/types";

import { Button, SectionHeading, TextInput } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="group flex flex-col gap-1.5 relative">
    <span className="ml-1 text-[11px] font-bold uppercase tracking-[0.1em] text-aura-muted transition-colors group-focus-within:text-aura-violet">
      {label}
    </span>
    {children}
  </label>
);

const ProfileForm = ({
  profile,
  onChange,
}: {
  profile: UserProfile;
  onChange: (next: UserProfile) => void;
}): JSX.Element => (
  <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
    <Field label="Full Name"><TextInput value={profile.fullName} onChange={(value) => onChange({ ...profile, fullName: value })} placeholder="Jane Doe" /></Field>
    <Field label="Email"><TextInput value={profile.email} onChange={(value) => onChange({ ...profile, email: value })} placeholder="jane@example.com" /></Field>
    <Field label="Phone"><TextInput value={profile.phone} onChange={(value) => onChange({ ...profile, phone: value })} placeholder="+1 (555) 000-0000" /></Field>
    <Field label="Address"><TextInput value={profile.addressLine1} onChange={(value) => onChange({ ...profile, addressLine1: value })} placeholder="123 Aura Street" /></Field>
    <Field label="City"><TextInput value={profile.city} onChange={(value) => onChange({ ...profile, city: value })} placeholder="San Francisco" /></Field>
    <Field label="State"><TextInput value={profile.state} onChange={(value) => onChange({ ...profile, state: value })} placeholder="CA" /></Field>
    <Field label="Postal Code"><TextInput value={profile.postalCode} onChange={(value) => onChange({ ...profile, postalCode: value })} placeholder="94105" /></Field>
    <Field label="Country"><TextInput value={profile.country} onChange={(value) => onChange({ ...profile, country: value })} placeholder="United States" /></Field>
  </div>
);

export const ProfilePage = (): JSX.Element => {
  const profile = useAuraStore((state) => state.profile);
  const saveProfile = useAuraStore((state) => state.saveProfile);
  const [draft, setDraft] = useState(profile);

  useEffect(() => setDraft(profile), [profile]);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1000px] flex-col overflow-y-auto pr-2 pb-8 mt-2">
      <div className="grid gap-12 xl:grid-cols-[1fr_320px]">
        <div className="flex flex-col">
        <SectionHeading title="Profile" detail="Saved identity and autofill details Aura can reuse during tasks." />
        <div className="mt-5">
          <ProfileForm profile={draft} onChange={setDraft} />
        </div>
        <div className="mt-5">
          <Button className="bg-aura-gradient text-white" onClick={() => void saveProfile(draft)}>
            Save Profile
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col">
          <SectionHeading title="Profile Preview" detail="The reusable identity Aura can apply across browser tasks." />
          <div className="mt-4 flex flex-col gap-3">
            <div className="rounded-[24px] border border-white/[0.08] bg-[#1a1926]/50 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.24)] backdrop-blur-3xl shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">Name</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{draft.fullName || "Not set yet"}</p>
            </div>
            <div className="rounded-[24px] border border-white/[0.08] bg-[#1a1926]/50 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.24)] backdrop-blur-3xl shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">Email</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{draft.email || "Not set yet"}</p>
            </div>
            <div className="rounded-[24px] border border-white/[0.08] bg-[#1a1926]/50 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.24)] backdrop-blur-3xl shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">Location</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">
                {[draft.city, draft.state, draft.country].filter(Boolean).join(", ") || "Not set yet"}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col">
          <SectionHeading title="Why It Matters" detail="A little profile context makes Aura much more useful in form-heavy flows." />
          <p className="mt-2 text-sm leading-7 text-aura-muted">
            Keep these details current and Aura can draft form inputs, personalize workflows, and reduce repeated setup during browser automation.
          </p>
        </div>
      </div>
      </div>
    </div>
  );
};
