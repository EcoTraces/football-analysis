import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        pitch: {
          50: "#f1f8f4",
          100: "#dcefe2",
          500: "#1f7a4d",
          600: "#186339",
          900: "#0d3320"
        }
      }
    }
  },
  plugins: []
} satisfies Config;
