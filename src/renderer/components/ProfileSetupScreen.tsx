import { useEffect, useState } from "react";

import type { UserProfile } from "@shared/types";

import { AuraLogoBlob } from "./primitives";
import { Button, TextInput } from "./shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const FormSection = ({ title, children }: { title: string; children: React.ReactNode }): JSX.Element => (
  <div className="mb-10">
    <h3 className="mb-4 text-[12px] font-bold uppercase tracking-[0.2em] text-aura-violet/80">{title}</h3>
    <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">{children}</div>
  </div>
);

export const ProfileForm = ({
  profile,
  onChange,
}: {
  profile: UserProfile;
  onChange: (next: UserProfile) => void;
}): JSX.Element => (
  <div className="mt-8 transition-all duration-700 ease-out">
    <FormSection title="Personal Information">
      <TextInput value={profile.fullName || ""} onChange={(value) => onChange({ ...profile, fullName: value })} placeholder="Full Name" />
      <TextInput value={profile.email || ""} onChange={(value) => onChange({ ...profile, email: value })} placeholder="Email Address" type="email" />
      <TextInput value={profile.phone || ""} onChange={(value) => onChange({ ...profile, phone: value })} placeholder="Phone Number" type="tel" />
    </FormSection>

    <FormSection title="Location">
      <TextInput value={profile.addressLine1 || ""} onChange={(value) => onChange({ ...profile, addressLine1: value })} placeholder="Address Line" />
      <TextInput value={profile.city || ""} onChange={(value) => onChange({ ...profile, city: value })} placeholder="City" />
      <TextInput value={profile.state || ""} onChange={(value) => onChange({ ...profile, state: value })} placeholder="State / Province" />
      <TextInput value={profile.postalCode || ""} onChange={(value) => onChange({ ...profile, postalCode: value })} placeholder="Postal Code" />
      <TextInput value={profile.country || ""} onChange={(value) => onChange({ ...profile, country: value })} placeholder="Country" />
    </FormSection>

    <FormSection title="Professional Details">
      <TextInput value={profile.currentJobTitle || ""} onChange={(value) => onChange({ ...profile, currentJobTitle: value })} placeholder="Current Job Title" />
      <TextInput value={profile.currentCompany || ""} onChange={(value) => onChange({ ...profile, currentCompany: value })} placeholder="Current Company" />
      <TextInput value={profile.linkedIn || ""} onChange={(value) => onChange({ ...profile, linkedIn: value })} placeholder="LinkedIn URL" />
      <TextInput value={profile.github || ""} onChange={(value) => onChange({ ...profile, github: value })} placeholder="GitHub URL" />
    </FormSection>
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
    <div className="flex h-screen w-full overflow-hidden bg-[#0A0A0F]">
      {/* Left Branding Panel (Hidden on mobile) */}
      <div className="relative hidden w-[45%] flex-col justify-between overflow-hidden bg-gradient-to-br from-[#12101F] to-[#0A0A0F] p-16 lg:flex xl:w-1/3">
        {/* Glow ambient background over the dark panel */}
        <div className="absolute -left-1/4 top-0 h-[600px] w-[600px] rounded-full bg-aura-violet/10 blur-[120px]" />
        
        <div className="relative z-10">
          <AuraLogoBlob size="lg" />
          <h1 className="mt-12 text-[2.5rem] font-extrabold leading-[1.15] tracking-tight text-white/95">
            Design your ideal<br/>
            <span className="bg-gradient-to-r from-aura-violet to-fuchsia-400 bg-clip-text text-transparent">conversational AI.</span>
          </h1>
          <p className="mt-6 max-w-[320px] text-[15px] leading-relaxed text-aura-muted/90">
            Providing your details helps Aura seamlessly personalize browser scripts, instantly fill tedious forms, and proactively assist you.
          </p>
        </div>

        <div className="relative z-10 w-full max-w-[320px]">
           <div className="rounded-[20px] border border-white/[0.04] bg-white/[0.02] p-5 backdrop-blur-xl transition-all hover:bg-white/[0.04]">
             <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-aura-violet/80">Privacy Architecture</p>
             <p className="mt-2 text-[13px] font-medium leading-relaxed text-white/80">Every detail entered restricts itself locally to your filesystem, encrypted implicitly by OpenClaw isolated vaults.</p>
           </div>
        </div>
      </div>

      {/* Right Form Panel */}
      <div className="flex w-full flex-col lg:w-[55%] xl:w-2/3">
        {/* Mobile Header */}
        <div className="flex items-center gap-4 border-b border-white/[0.05] bg-black/40 px-8 py-6 backdrop-blur-3xl lg:hidden">
          <AuraLogoBlob size="sm" />
          <h1 className="text-xl font-bold tracking-tight text-white">Profile Setup</h1>
        </div>
        
        <div className="relative flex-1 overflow-y-auto px-8 py-12 lg:px-24 xl:px-32">
          {/* Subtle background glow for the right panel */}
          <div className="pointer-events-none absolute right-0 top-1/4 h-[500px] w-[500px] rounded-full bg-aura-violet/5 blur-[120px]" />

          <div className="relative z-10 mx-auto w-full max-w-3xl">
            <div className="mb-8 lg:hidden">
              <h2 className="text-2xl font-bold tracking-tight text-white">Welcome Context</h2>
              <p className="mt-2 text-sm text-aura-muted">Provide your details to unlock a fully personalized experience.</p>
            </div>
            
            <ProfileForm profile={draft} onChange={setDraft} />
            
            <div className="mt-14 flex items-center gap-4 border-t border-white/[0.05] pt-8">
              <Button
                className="w-[180px] bg-aura-gradient text-white shadow-[0_0_24px_rgba(124,58,237,0.15)] hover:shadow-[0_0_32px_rgba(124,58,237,0.25)]"
                onClick={async () => {
                  await saveProfile(draft);
                  await onDone();
                }}
              >
                Complete Setup
              </Button>
              {onSkip && (
                <Button
                  className="w-[140px] border border-white/10 bg-transparent text-aura-muted transition-colors hover:bg-white/[0.06] hover:text-white"
                  onClick={() => void onSkip()}
                >
                  Skip for now
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
