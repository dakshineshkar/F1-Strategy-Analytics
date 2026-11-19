import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // a build-time transform of the Next compiler (empty at runtime): see tests/stubs/next-font-local.ts
      "next/font/local": fileURLToPath(new URL("./tests/stubs/next-font-local.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
  },
});
