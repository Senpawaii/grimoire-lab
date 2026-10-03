// Fails if any source file changed relative to <base> has under 90% line, statement or function
// coverage. Usage: node scripts/coverage-changed.mjs [base-ref]   (default: origin/main)
import { execFileSync, spawnSync } from "node:child_process";

const THRESHOLD = 90;
const base = process.argv[2] ?? "origin/main";

const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=d", `${base}...HEAD`], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean);

// Tests, index.ts re-exports, bin.ts and types.ts are excluded by vitest.config.ts.
const files = changed.filter((f) => /^packages\/[^/]+\/src\/.+\.ts$/.test(f));

if (files.length === 0) {
  console.log(`No changed source files vs ${base}; nothing to check.`);
  process.exit(0);
}

console.log(`Checking coverage (>= ${THRESHOLD}% per file) for:\n  ${files.join("\n  ")}\n`);

const args = [
  "exec",
  "vitest",
  "run",
  "--coverage",
  ...files.map((f) => `--coverage.include=${f}`),
  "--coverage.thresholds.perFile=true",
  `--coverage.thresholds.lines=${THRESHOLD}`,
  `--coverage.thresholds.statements=${THRESHOLD}`,
  `--coverage.thresholds.functions=${THRESHOLD}`,
];
const result = spawnSync("pnpm", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
