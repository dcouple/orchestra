import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/console", emptyOutDir: true, sourcemap: false },
  test: { environment: "jsdom", setupFiles: "./src/test-setup.ts", css: true },
});
