import type { ReactNode } from "react";

export const Card = ({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element => (
  <div
    className={`glass-panel relative overflow-hidden rounded-[28px] shadow-[0_18px_60px_rgba(3,6,20,0.28)] ${className}`}
  >
    {children}
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
    className={`rounded-2xl px-4 py-2.5 text-sm font-semibold transition duration-200 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
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
    className="w-full rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm text-aura-text outline-none transition placeholder:text-aura-muted focus:border-aura-violet/50 focus:bg-white/8"
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
    className="w-full resize-none rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-sm text-aura-text outline-none transition placeholder:text-aura-muted focus:border-aura-violet/50 focus:bg-white/8"
  />
);

export const SectionHeading = ({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}): JSX.Element => (
  <div>
    <h2 className="text-lg font-semibold tracking-tight text-aura-text">{title}</h2>
    {detail && <p className="mt-1 text-sm text-aura-muted">{detail}</p>}
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
  <div className="rounded-[22px] border border-white/8 bg-black/10 px-4 py-4">
    <p className="text-[11px] uppercase tracking-[0.22em] text-aura-muted">{label}</p>
    <p className="mt-3 text-xl font-semibold tracking-tight text-aura-text">{value}</p>
    <p className="mt-1 text-sm text-aura-muted">{detail}</p>
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
  <label className="flex items-center justify-between gap-4 rounded-[22px] border border-white/8 bg-white/5 px-4 py-4">
    <div className="min-w-0">
      <p className="text-sm font-medium text-aura-text">{label}</p>
      {detail && <p className="mt-1 text-xs leading-5 text-aura-muted">{detail}</p>}
    </div>
    <div className="shrink-0">{control}</div>
  </label>
);
