import type { ReactNode } from "react";

const FIELD_CLASS =
  "w-full rounded-[18px] border border-white/[0.08] bg-black/20 px-4 py-3.5 text-[14px] text-aura-text outline-none transition-all placeholder:text-aura-muted/85 hover:border-white/[0.12] hover:bg-black/30 focus:border-transparent focus:bg-black/40 focus:ring-2 focus:ring-aura-violet/45 focus:shadow-[0_0_24px_rgba(124,58,237,0.14)]";

export const Card = ({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element => (
  <div
    className={`relative overflow-hidden rounded-[30px] border border-white/[0.09] bg-[linear-gradient(160deg,rgba(26,25,38,0.82),rgba(16,17,28,0.78))] p-6 backdrop-blur-[28px] shadow-[0_20px_60px_rgba(3,6,20,0.34),inset_0_1px_0_rgba(255,255,255,0.06)] transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-0.5 hover:border-white/[0.14] hover:shadow-[0_26px_80px_rgba(3,6,20,0.4),inset_0_1px_0_rgba(255,255,255,0.08)] ${className}`}
  >
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.14),transparent_44%),radial-gradient(circle_at_bottom_left,rgba(244,114,182,0.08),transparent_46%)]" />
    <div className="relative z-10">{children}</div>
  </div>
);

export const Button = ({
  children,
  className = "",
  onClick,
  type = "button",
  disabled = false,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
}): JSX.Element => (
  <button
    type={type}
    disabled={disabled}
    onClick={onClick}
    className={`inline-flex items-center justify-center gap-2 rounded-2xl border border-white/[0.1] bg-white/[0.06] px-5 py-3 text-[14px] font-semibold tracking-wide text-aura-text shadow-[0_10px_24px_rgba(3,6,20,0.25)] transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.16] hover:bg-white/[0.1] hover:shadow-[0_14px_34px_rgba(3,6,20,0.32)] active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aura-violet/45 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-white/[0.06] ${className}`}
  >
    {children}
  </button>
);

export const TextInput = ({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
}): JSX.Element => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className={FIELD_CLASS}
  />
);

export const TextArea = ({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows?: number;
}): JSX.Element => (
  <textarea
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    rows={rows}
    className={`${FIELD_CLASS} resize-none py-4`}
  />
);

export const SectionHeading = ({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}): JSX.Element => (
  <div className="mb-2">
    <h2 className="text-[20px] font-bold tracking-tight text-aura-text">{title}</h2>
    {detail && <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-aura-muted">{detail}</p>}
  </div>
);

export const InfoTile = ({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element => (
  <div className="rounded-[24px] border border-white/[0.06] bg-white/[0.02] px-5 py-5 transition-all duration-300 hover:-translate-y-1 hover:bg-white/[0.04] hover:border-white/[0.1] hover:shadow-xl hover:shadow-aura-violet/5">
    <p className="text-[11px] uppercase tracking-[0.2em] text-aura-muted">{label}</p>
    <p className="mt-3 text-[32px] font-bold tracking-tight text-aura-text">{value}</p>
    <p className="mt-1 pb-1 text-[13px] text-aura-muted opacity-80">{detail}</p>
  </div>
);

export const SettingRow = ({
  label,
  detail,
  control,
}: {
  label: string;
  detail?: string;
  control: ReactNode;
}): JSX.Element => (
  <label className="group flex cursor-pointer items-center justify-between gap-5 rounded-[24px] border border-white/[0.05] bg-white/[0.02] px-5 py-4 transition-all hover:border-white/[0.1] hover:bg-white/[0.04]">
    <div className="min-w-0 flex-1">
      <p className="text-[15px] font-semibold text-aura-text transition-colors group-hover:text-white">{label}</p>
      {detail && <p className="mt-1.5 text-[13px] leading-relaxed text-aura-muted">{detail}</p>}
    </div>
    <div className="shrink-0">{control}</div>
  </label>
);

export const Switch = ({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border border-white/12 transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aura-violet/50 ${
      checked ? "bg-[linear-gradient(120deg,#7c3aed,#22d3ee)]" : "bg-white/10"
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-[0_6px_16px_rgba(0,0,0,0.35)] ring-0 transition duration-200 ease-in-out ${
        checked ? "translate-x-5" : "translate-x-0"
      }`}
    />
  </button>
);
