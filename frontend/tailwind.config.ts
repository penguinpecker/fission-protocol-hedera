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
        border: "rgba(255,255,255,0.06)",
        borderHover: "rgba(255,255,255,0.12)",
        text: "#fafafa",
        textSec: "#a1a1aa",
        textDim: "#52525b",
        silver: "#c0c0c8",
        silverDark: "#71717a",
        success: "#a1e6a1",
        error: "#f87171",
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
