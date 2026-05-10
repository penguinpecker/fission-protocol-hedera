import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#09090b",
        bgCard: "#111113",
        bgElevated: "#161618",
        bgInput: "#0c0c0e",
        border: "rgba(255,255,255,0.08)",
        borderHover: "rgba(255,255,255,0.18)",
        text: "#fafafa",
        textSec: "#d4d4d8",
        textDim: "#a1a1aa",
        silver: "#c0c0c8",
        silverDark: "#71717a",
        success: "#86efac",
        error: "#f87171",
        warning: "#fbbf24",
        accent: "#7dd3fc",
      },
      fontFamily: {
        sans: ["Outfit", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        serif: ["Instrument Serif", "Times New Roman", "serif"],
      },
    },
  },
  plugins: [],
};

export default config;
