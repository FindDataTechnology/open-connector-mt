import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import { providerIconsPlugin } from "./web/provider-icons-plugin";

export default defineConfig({
  plugins: [providerIconsPlugin({ iconUrls: {} })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  test: {
    // open-connector-mt: web tests are collected as .tsx too. The upstream
    // globs matched .ts only, so a web/src/**/*.test.tsx file was silently
    // never run — it looked like a green suite.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
