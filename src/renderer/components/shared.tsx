import type { ReactNode } from "react";

export const Card = ({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element => (
  <div
    className={`relative overflow-hidden rounded-[32px] border border-white/[0.08] bg-[#1a1926]/50 p-6 shadow-[0_8px_32px_rgba(0,0,0,0.24)] backdrop-blur-3xl transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${className}`}
  >
    <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent mix-blend-overlay" />
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
    className={`rounded-2xl px-5 py-3 text-[14px] font-semibold tracking-wide shadow-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-lg hover:shadow-aura-violet/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 ${className}`}
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
    className="w-full rounded-[20px] border border-white/[0.06] bg-black/20 px-5 py-3.5 text-[14px] text-aura-text outline-none transition-all placeholder:text-aura-muted hover:bg-black/30 focus:bg-black/40 focus:ring-2 focus:ring-aura-violet/50 focus:border-transparent focus:shadow-[0_0_24px_rgba(124,58,237,0.15)]"
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
    className="w-full resize-none rounded-[20px] border border-white/[0.06] bg-black/20 px-5 py-4 text-[14px] text-aura-text outline-none transition-all placeholder:text-aura-muted hover:bg-black/30 focus:bg-black/40 focus:ring-2 focus:ring-aura-violet/50 focus:border-transparent focus:shadow-[0_0_24px_rgba(124,58,237,0.15)]"
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
  <label className="group flex cursor-pointer items-center justify-between gap-5 rounded-[24px] border border-white/[0.04] bg-white/[0.02] px-5 py-4 transition-all hover:border-white/[0.08] hover:bg-white/[0.04]">
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
    className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-aura-violet/50 ${
      checked ? "bg-aura-violet" : "bg-white/10"
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
        checked ? "translate-x-5" : "translate-x-0"
      }`}
    />
  </button>
);
