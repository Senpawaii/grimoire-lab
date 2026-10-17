// Packs @grimoire/core, installs the tarball into a fresh temp project, then checks that
// (a) every export in EXPORTS resolves at runtime and (b) a typed consumer file compiles.
// Run after `pnpm build`:  node scripts/smoke-consume.mjs
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Public API checked from a consumer. Other slices: append your exports here.
// kind "function" is asserted with typeof at runtime and imported by the type-check file;
// kind "value" is only asserted to be defined at runtime.
const EXPORTS = [
  { name: "loadSkill", kind: "function" },
  { name: "digestDir", kind: "function" },
  { name: "runBench", kind: "function" },
  { name: "parseBenchResult", kind: "function" },
  { name: "buildBenchResult", kind: "function" },
  { name: "BenchResultSchema", kind: "value" },
  { name: "compare", kind: "function" },
  { name: "armRef", kind: "function" },
  { name: "deriveKind", kind: "function" },
  { name: "evidenceFor", kind: "function" },
  { name: "digestSuite", kind: "function" },
  { name: "proposeVersion", kind: "function" },
  { name: "stageCandidate", kind: "function" },
  { name: "RewriterNotAvailable", kind: "value" },
  { name: "NoChange", kind: "value" },
  { name: "benchSkill", kind: "function" },
  { name: "benchProposal", kind: "function" },
  { name: "formatReport", kind: "function" },
];

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const coreDir = join(root, "packages", "core");
const isWin = process.platform === "win32";

function run(cmd, args, cwd) {
  // pnpm is a .cmd shim on Windows, which needs a shell.
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell: isWin,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

if (!existsSync(join(coreDir, "dist", "index.js"))) {
  console.error("packages/core/dist is missing; run `pnpm build` first.");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "grimoire-smoke-"));
let failed = false;
try {
  const packDir = join(tmp, "pack");
  mkdirSync(packDir);
  run("pnpm", ["pack", "--pack-destination", packDir], coreDir);
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("pnpm pack produced no tarball");
  const tarball = join(packDir, tgz);

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tsRange = rootPkg.devDependencies.typescript;
  const nodeTypesRange = rootPkg.devDependencies["@types/node"];

  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }, null, 2),
  );
  // A fresh project: the tarball's own dependencies (execa, yaml, zod) must resolve from the registry.
  run("pnpm", ["add", "--prefer-offline", tarball], app);
  run(
    "pnpm",
    ["add", "-D", "--prefer-offline", `typescript@${tsRange}`, `@types/node@${nodeTypesRange}`],
    app,
  );

  const fnNames = EXPORTS.filter((e) => e.kind === "function").map((e) => e.name);
  const allNames = EXPORTS.map((e) => e.name);

  // (a) runtime import
  writeFileSync(
    join(app, "runtime.mjs"),
    `import * as core from "@grimoire/core";
const specs = ${JSON.stringify(EXPORTS)};
for (const { name, kind } of specs) {
  if (kind === "function" ? typeof core[name] !== "function" : core[name] === undefined) {
    throw new Error("@grimoire/core does not export " + name + " (" + kind + ")");
  }
}
console.log("runtime ok: " + specs.length + " exports");
`,
  );
  process.stdout.write(run("node", ["runtime.mjs"], app));

  // (b) type-check a consumer: each function export must be a real typed function, not any.
  const lines = [
    `import { ${allNames.join(", ")} } from "@grimoire/core";`,
    "type IsAny<T> = 0 extends 1 & T ? true : false;",
    "type NotAny<T extends false> = T;",
    ...fnNames.map((n) => `export type ${n}NotAny = NotAny<IsAny<typeof ${n}>>;`),
    ...fnNames.map((n) => `export const ${n}Ref: (...a: never[]) => unknown = ${n};`),
    // Typed usage of the three core entry points named by the library contract.
    'import type { Skill } from "@grimoire/core";',
    'import type { BenchProposal, BenchProposalOptions, BenchResult, BenchSkillOptions } from "@grimoire/core";',
    "export type BenchTypes = [BenchSkillOptions, BenchProposalOptions, BenchProposal, BenchResult];",
    "export const report: (r: BenchResult) => string = formatReport;",
    "export const bench: (o: BenchSkillOptions) => Promise<BenchResult> = benchSkill;",
    "export const propose: (o: BenchProposalOptions) => Promise<BenchProposal> = benchProposal;",
    "export async function check(dir: string): Promise<string> {",
    "  const skill: Skill = await loadSkill(dir);",
    "  const digest: string = await digestDir(dir);",
    "  return skill.name + digest;",
    "}",
    "void runBench;",
    "",
  ];
  writeFileSync(join(app, "consumer.ts"), lines.join("\n"));
  writeFileSync(
    join(app, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    ),
  );
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], app);
  console.log("type-check ok");
  console.log("smoke-consume: PASS");
} catch (err) {
  failed = true;
  console.error("smoke-consume: FAIL");
  console.error(err instanceof Error ? err.message : err);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
