import { useEffect, useState } from "react";

import type { UserProfile } from "@shared/types";

import { AuraLogoBlob } from "./primitives";
import { Button, Card, TextInput } from "./shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

export const ProfileForm = ({
  profile,
  onChange,
}: {
  profile: UserProfile;
  onChange: (next: UserProfile) => void;
}): JSX.Element => (
  <div className="grid gap-3 md:grid-cols-2">
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

export const ProfileSetupScreen = ({
  onDone,
  onSkip,
}: {
  onDone: () => Promise<void>;
  onSkip?: () => Promise<void>;
}): JSX.Element => {
  const profile = useAuraStore((state) => state.profile);
  const saveProfile = useAuraStore((state) => state.saveProfile);
  const [draft, setDraft] = useState(profile);

  useEffect(() => setDraft(profile), [profile]);

  return (
    <div className="flex h-full items-center justify-center px-6">
      <Card className="w-full max-w-[920px] px-8 py-8">
        <div className="mb-8 flex items-center gap-4">
          <AuraLogoBlob size="lg" />
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-aura-violet">Conversational Profile Setup</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-aura-text">Give Aura your reusable context</h1>
            <p className="mt-2 text-sm text-aura-muted">
              These details help Aura fill forms, personalize browser tasks, and keep OpenClaw helpful without asking the same questions every time.
            </p>
          </div>
        </div>
        <ProfileForm profile={draft} onChange={setDraft} />
        <div className="mt-6 flex items-center gap-3">
          <Button
            className="bg-aura-gradient text-white"
            onClick={async () => {
              await saveProfile(draft);
              await onDone();
            }}
          >
            Finish Setup
          </Button>
          {onSkip && (
            <Button
              className="border border-white/10 bg-white/6 text-aura-muted hover:bg-white/10"
              onClick={() => void onSkip()}
            >
              Skip for now
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};
