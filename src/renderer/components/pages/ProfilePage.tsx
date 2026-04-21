import { useEffect, useState } from "react";

import type { UserProfile } from "@shared/types";

import { Button, Card, SectionHeading, TextInput } from "../shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <label className="group relative flex flex-col gap-1.5">
    <span className="ml-1 text-[11px] font-bold uppercase tracking-[0.12em] text-aura-muted transition-colors group-focus-within:text-aura-violet">
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
    <Field label="Full Name">
      <TextInput
        value={profile.fullName}
        onChange={(value) => onChange({ ...profile, fullName: value })}
        placeholder="Jane Doe"
      />
    </Field>
    <Field label="Email">
      <TextInput
        value={profile.email}
        onChange={(value) => onChange({ ...profile, email: value })}
        placeholder="jane@example.com"
      />
    </Field>
    <Field label="Phone">
      <TextInput
        value={profile.phone}
        onChange={(value) => onChange({ ...profile, phone: value })}
        placeholder="+1 (555) 000-0000"
      />
    </Field>
    <Field label="Address">
      <TextInput
        value={profile.addressLine1}
        onChange={(value) => onChange({ ...profile, addressLine1: value })}
        placeholder="123 Aura Street"
      />
    </Field>
    <Field label="City">
      <TextInput
        value={profile.city}
        onChange={(value) => onChange({ ...profile, city: value })}
        placeholder="San Francisco"
      />
    </Field>
    <Field label="State">
      <TextInput
        value={profile.state}
        onChange={(value) => onChange({ ...profile, state: value })}
        placeholder="CA"
      />
    </Field>
    <Field label="Postal Code">
      <TextInput
        value={profile.postalCode}
        onChange={(value) => onChange({ ...profile, postalCode: value })}
        placeholder="94105"
      />
    </Field>
    <Field label="Country">
      <TextInput
        value={profile.country}
        onChange={(value) => onChange({ ...profile, country: value })}
        placeholder="United States"
      />
    </Field>
  </div>
);

/* ── Profile preview badge card ─────────────────────────────────────── */
const PreviewBadge = ({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: JSX.Element;
}): JSX.Element => (
  <div className="group relative overflow-hidden rounded-[20px] border border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-white/[0.1] hover:shadow-[0_6px_24px_rgba(124,58,237,0.08)]">
    <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-aura-violet/25 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.06] bg-white/[0.04] text-aura-muted transition-colors group-hover:border-aura-violet/30 group-hover:bg-aura-violet/10 group-hover:text-aura-violet">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-aura-muted">
          {label}
        </p>
        <p className="mt-0.5 truncate text-[14px] font-semibold text-aura-text transition-colors group-hover:text-white">
          {value || "Not set yet"}
        </p>
      </div>
    </div>
  </div>
);

export const ProfilePage = (): JSX.Element => {
  const authState = useAuraStore((state) => state.authState);
  const profile = useAuraStore((state) => state.profile);
  const saveProfile = useAuraStore((state) => state.saveProfile);
  const signOutUser = useAuraStore((state) => state.signOutUser);
  const [draft, setDraft] = useState(profile);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);

  useEffect(() => setDraft(profile), [profile]);

  const handleSignOut = async (): Promise<void> => {
    setIsSigningOut(true);
    setAccountNotice(null);
    try {
      await signOutUser();
    } catch (error) {
      setAccountNotice(
        error instanceof Error
          ? error.message
          : "Could not sign out right now.",
      );
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1000px] flex-col overflow-y-auto pr-2 pb-8 mt-2">
      <div className="grid gap-10 xl:grid-cols-[1fr_340px]">
        {/* ── Left: Profile Form ──────────────────────────────────────── */}
        <div className="flex flex-col">
          <SectionHeading
            title="Profile"
            detail="Saved identity and autofill details Aura can reuse during tasks."
          />
          <div className="mt-5 rounded-[24px] border border-white/[0.06] bg-gradient-to-b from-white/[0.02] to-transparent p-6">
            <ProfileForm profile={draft} onChange={setDraft} />
            <div className="mt-6">
              <Button
                className="bg-aura-gradient text-white shadow-[0_4px_16px_rgba(124,58,237,0.3)] hover:shadow-[0_6px_24px_rgba(124,58,237,0.4)]"
                onClick={() => void saveProfile(draft)}
              >
                Save Profile
              </Button>
            </div>
          </div>
        </div>

        {/* ── Right: Preview + Account ────────────────────────────────── */}
        <div className="flex flex-col gap-8">
          {/* Profile Preview */}
          <div className="flex flex-col">
            <SectionHeading
              title="Profile Preview"
              detail="The reusable identity Aura can apply across browser tasks."
            />
            <div className="mt-4 flex flex-col gap-3">
              <PreviewBadge
                label="Name"
                value={draft.fullName}
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                }
              />
              <PreviewBadge
                label="Email"
                value={draft.email}
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                }
              />
              <PreviewBadge
                label="Location"
                value={
                  [draft.city, draft.state, draft.country]
                    .filter(Boolean)
                    .join(", ") || ""
                }
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                }
              />
              <PreviewBadge
                label="Phone"
                value={draft.phone}
                icon={
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
                  </svg>
                }
              />
            </div>
          </div>

          {/* Account Session */}
          <div className="flex flex-col">
            <SectionHeading
              title="Account Session"
              detail="Manage the signed-in desktop account."
            />
            <Card className="mt-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-aura-violet/10 text-aura-violet">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-aura-text">
                    Signed in
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-aura-muted">
                    {authState.email || "Desktop account"}
                    {authState.provider ? ` via ${authState.provider}` : ""}
                  </p>
                </div>
              </div>
              {accountNotice && (
                <p className="mt-3 text-[13px] text-amber-400">
                  {accountNotice}
                </p>
              )}
              <div className="mt-4">
                <Button
                  className="bg-red-500/90 text-white hover:bg-red-500"
                  disabled={isSigningOut}
                  onClick={() => void handleSignOut()}
                >
                  {isSigningOut ? "Signing Out..." : "Sign Out"}
                </Button>
              </div>
            </Card>
          </div>

          {/* Info card */}
          <div className="rounded-[20px] border border-white/[0.05] bg-gradient-to-b from-aura-violet/[0.04] to-transparent p-5">
            <p className="text-[12px] font-bold uppercase tracking-[0.15em] text-aura-violet/80">
              Why It Matters
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-aura-muted">
              Keep these details current and Aura can draft form inputs,
              personalize workflows, and reduce repeated setup during browser
              automation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
