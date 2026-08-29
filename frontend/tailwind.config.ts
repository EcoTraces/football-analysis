import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Brand green, extended with 400/700/800 for hover/active/pressed
        // states — the 50/100/500/600/900 shades already carried the brand
        // and are unchanged.
        pitch: {
          50: "#f1f8f4",
          100: "#dcefe2",
          400: "#2e9463",
          500: "#1f7a4d",
          600: "#186339",
          700: "#124c2c",
          800: "#0f3f25",
          900: "#0d3320"
        }
      },
      fontFamily: {
        // Inter for all UI text/headings — neutral, highly legible,
        // reads as "serious analytics product" rather than decorative.
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        // JetBrains Mono specifically for prediction percentages,
        // confidence scores, and other tabular figures (font-mono is
        // already applied to those in PredictionCard) — fixed-width
        // digits keep a column of numbers from shifting as values change.
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"]
      }
    }
  },
  plugins: []
} satisfies Config;
