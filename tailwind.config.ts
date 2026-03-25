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
          success: "#10b981",
          error: "#ef4444",
          muted: "rgb(var(--aura-muted) / <alpha-value>)",
          text: "rgb(var(--aura-text) / <alpha-value>)",
          surface: "rgb(var(--aura-surface) / <alpha-value>)",
          card: "rgb(var(--aura-card) / <alpha-value>)"
        }
      },
      boxShadow: {
        "aura-glow": "var(--aura-glow)",
        bubble: "0 18px 42px rgba(124, 58, 237, 0.28)"
      },
      backgroundImage: {
        "aura-gradient": "linear-gradient(135deg, #7c3aed 0%, #6366f1 52%, #06b6d4 100%)"
      }
    }
  },
  plugins: []
} satisfies Config;
