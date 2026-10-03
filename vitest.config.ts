import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@grimoire/core": src("core"),
      "@grimoire/adapters": src("adapters"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // index.ts files only re-export; bin.ts is the process entrypoint (see scripts/coverage-changed.mjs).
      exclude: ["**/*.test.ts", "**/index.ts", "**/bin.ts", "**/types.ts"],
      reporter: ["text"],
    },
  },
});
