import { useEffect, useState } from "react";

import type { UserProfile } from "@shared/types";

import { Button, Card, SectionHeading, TextInput } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const ProfileForm = ({
  profile,
  onChange,
}: {
  profile: UserProfile;
  onChange: (next: UserProfile) => void;
}): JSX.Element => (
  <div className="grid gap-5 md:grid-cols-2">
    <TextInput value={profile.fullName} onChange={(value) => onChange({ ...profile, fullName: value })} placeholder="Full name" />
    <TextInput value={profile.email} onChange={(value) => onChange({ ...profile, email: value })} placeholder="Email" />
    <TextInput value={profile.phone} onChange={(value) => onChange({ ...profile, phone: value })} placeholder="Phone" />
    <TextInput value={profile.addressLine1} onChange={(value) => onChange({ ...profile, addressLine1: value })} placeholder="Address line" />
    <TextInput value={profile.city} onChange={(value) => onChange({ ...profile, city: value })} placeholder="City" />
    <TextInput value={profile.state} onChange={(value) => onChange({ ...profile, state: value })} placeholder="State" />
    <TextInput value={profile.postalCode} onChange={(value) => onChange({ ...profile, postalCode: value })} placeholder="Postal code" />
    <TextInput value={profile.country} onChange={(value) => onChange({ ...profile, country: value })} placeholder="Country" />
  </div>
);

export const ProfilePage = (): JSX.Element => {
  const profile = useAuraStore((state) => state.profile);
  const saveProfile = useAuraStore((state) => state.saveProfile);
  const [draft, setDraft] = useState(profile);

  useEffect(() => setDraft(profile), [profile]);

  return (
    <div className="grid h-full min-h-0 gap-5 overflow-y-auto pr-1 xl:grid-cols-[minmax(0,1.35fr)_320px]">
      <Card className="min-h-0 px-5 py-5">
        <SectionHeading title="Profile" detail="Saved identity and autofill details Aura can reuse during tasks." />
        <div className="mt-5">
          <ProfileForm profile={draft} onChange={setDraft} />
        </div>
        <div className="mt-5">
          <Button className="bg-aura-gradient text-white" onClick={() => void saveProfile(draft)}>
            Save Profile
          </Button>
        </div>
      </Card>
      <div className="flex min-h-0 flex-col gap-4">
        <Card className="px-5 py-5">
          <SectionHeading title="Profile Preview" detail="The reusable identity Aura can apply across browser tasks." />
          <div className="mt-4 space-y-3">
            <div className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Name</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{draft.fullName || "Not set yet"}</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Email</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">{draft.email || "Not set yet"}</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
              <p className="text-xs uppercase tracking-[0.2em] text-aura-muted">Location</p>
              <p className="mt-2 text-sm font-semibold text-aura-text">
                {[draft.city, draft.state, draft.country].filter(Boolean).join(", ") || "Not set yet"}
              </p>
            </div>
          </div>
        </Card>
        <Card className="px-5 py-5">
          <SectionHeading title="Why It Matters" detail="A little profile context makes Aura much more useful in form-heavy flows." />
          <p className="mt-4 text-sm leading-7 text-aura-muted">
            Keep these details current and Aura can draft form inputs, personalize workflows, and reduce repeated setup during browser automation.
          </p>
        </Card>
      </div>
    </div>
  );
};
