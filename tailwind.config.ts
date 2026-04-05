import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        aura: {
          violet: "#7c3aed",
          indigo: "#6366f1",
          cyan: "#06b6d4",
          pink: "#ec4899",
          purple: "#a855f7",
          warning: "#f59e0b",
          success: "#10b981",
          error: "#ef4444",
          muted: "rgb(var(--aura-muted) / <alpha-value>)",
          text: "rgb(var(--aura-text) / <alpha-value>)",
          bg: "rgb(var(--aura-bg) / <alpha-value>)",
          surface: "rgb(var(--aura-surface) / <alpha-value>)",
          card: "rgb(var(--aura-card) / <alpha-value>)",
        },
      },
      boxShadow: {
        "aura-glow": "var(--aura-glow)",
        "aura-bubble": "0 18px 42px rgba(124, 58, 237, 0.28)",
        "aura-inner": "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
      },
      backgroundImage: {
        "aura-gradient": "linear-gradient(135deg, #7c3aed 0%, #6366f1 52%, #06b6d4 100%)",
        "aura-header": "linear-gradient(180deg, rgba(35, 33, 54, 0.6) 0%, rgba(26, 25, 41, 0.4) 100%)",
      },
      fontFamily: {
        aura: ["var(--aura-font)", "sans-serif"],
        "aura-display": ["var(--aura-display-font)", "sans-serif"],
      },
      borderRadius: {
        "aura": "28px",
        "aura-sm": "16px",
        "aura-xs": "12px",
      },
      animation: {
        "msg-enter": "msg-enter 0.18s ease-out both",
        "overlay-enter": "overlay-enter 0.28s cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-up": "fade-up 0.35s ease-out both",
        "task-banner-enter": "task-banner-enter 0.3s cubic-bezier(0.22, 1, 0.36, 1) both",
        "step-enter": "step-enter 0.25s ease-out both",
        "check-pop": "check-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        "blob-morph": "blob-morph 8s ease-in-out infinite",
        "blob-morph-reverse": "blob-morph-reverse 8s ease-in-out infinite",
        "shimmer-bar": "shimmer-bar 1.8s ease-in-out infinite",
        "glow-pulse": "glow-pulse 3s ease-in-out infinite",
        "pulse-ring": "pulse-ring 1.5s ease-out infinite",
        "pulse-subtle": "pulse-subtle 1.25s ease-in-out infinite",
        "spin-slow": "spin 2s linear infinite",
      },
    },
  },
  plugins: [
    require("@tailwindcss/typography"),
  ],
} satisfies Config;
