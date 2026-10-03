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
  },
});
