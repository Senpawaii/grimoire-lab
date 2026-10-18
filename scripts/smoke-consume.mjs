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
  { name: "resumeBench", kind: "function" },
  { name: "ResumeMismatch", kind: "value" },
  { name: "formatReport", kind: "function" },
  { name: "dirSource", kind: "function" },
  { name: "gitSource", kind: "function" },
  { name: "resolveSkill", kind: "function" },
  { name: "loadSkillByDigest", kind: "function" },
  { name: "listSkills", kind: "function" },
  { name: "parseSuite", kind: "function" },
  { name: "DigestMismatch", kind: "value" },
];

// Runs inside the fresh consumer project, importing only the public package root.
const FLOW_SCRIPT = `
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DigestMismatch, benchProposal, benchSkill, dirSource, evidenceFor, gitSource, listSkills,
  loadSkill, loadSkillByDigest, parseSuite, resolveSkill, stageCandidate,
} from "@grimoire/core";

const tmp = mkdtempSync(join(tmpdir(), "grimoire-flow-"));
const skillMd = (v, body) => "---\\nname: demo\\ndescription: d\\nversion: " + v + "\\n---\\n" + body + "\\n";
const writeSkill = (root, v, body) => {
  mkdirSync(join(root, "demo"), { recursive: true });
  writeFileSync(join(root, "demo", "SKILL.md"), skillMd(v, body));
  writeFileSync(join(root, "demo", "grimoire.bench.yaml"), "suite: s\\n");
};

// A git source with a tagged historical version and a newer HEAD.
const repo = join(tmp, "repo");
mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, stdio: "ignore" });
git("init", "-q");
writeSkill(join(repo, "skills"), "1.0.0", "first");
git("add", "-A"); git("commit", "-q", "-m", "v1"); git("tag", "demo@1.0.0");
writeSkill(join(repo, "skills"), "1.1.0", "second");
git("add", "-A"); git("commit", "-q", "-m", "v1.1");
const gsrc = gitSource({ repo, path: "skills", id: "git" });

const head = await resolveSkill("demo", [gsrc]);
const old = await resolveSkill("demo@1.0.0", [gsrc]);
assert.equal(head.version, "1.1.0");
assert.equal(old.version, "1.0.0");
assert.notEqual(head.digest, old.digest);

// A custom source implementing the two-method interface, and one that returns the wrong content.
const store = join(tmp, "store");
writeSkill(store, "9.9.9", "custom");
const custom = { id: "custom", list: () => dirSource(store).list(), load: (d) => dirSource(store).load(d) };
const customRef = await resolveSkill("demo", [custom]);
writeSkill(join(tmp, "elsewhere"), "0.0.1", "other");
const wrong = {
  id: "wrong",
  list: async () => [{ ...customRef, description: "d", source: "wrong" }],
  load: async () => ({ skill: await loadSkill(join(tmp, "elsewhere", "demo")), dispose: async () => {} }),
};
await assert.rejects(loadSkillByDigest(customRef.digest, [wrong]), DigestMismatch);

// One failing source must not take the catalog down when the consumer opts in.
const failures = [];
const failing = { id: "failing", list: () => Promise.reject(new Error("down")), load: () => Promise.reject(new Error("down")) };
assert.equal((await resolveSkill("demo@1.0.0", [failing, gsrc], { onSourceError: (e) => failures.push(e) })).digest, old.digest);
assert.equal((await listSkills([failing, gsrc], { onSourceError: () => {} })).length, 2);
assert.equal(failures.length, 1);
await assert.rejects(resolveSkill("demo@1.0.0", [failing, gsrc]), /down/);

// Bench the historical version with a stub agent that obeys the skill only if it is installed.
const suite = parseSuite("suite: s\\ndefaults: { repeat: 2 }\\ntasks:\\n  - id: t\\n    prompt: go\\n    assertions: [{ type: file_exists, path: out.txt }]\\n", tmp);
const installed = new Map();
const adapter = {
  id: "stub",
  detect: async () => ({ available: true, version: "1" }),
  install: async (s, ws) => { installed.set(ws.root, s.name + ":" + s.version); },
  run: async (_req, ws) => {
    const v = installed.get(ws.root);
    if (v === "demo:1.1.0") writeFileSync(join(ws.dir, "out.txt"), "x");
    return { status: "completed", transcript: [], finalMessage: "", durationMs: 1, rawOutput: "", usage: { tokens: 5 } };
  },
};
const loadedNew = await loadSkillByDigest(head.digest, [gsrc]);
const result = await benchSkill({ skill: loadedNew.skill, suite, adapter, outDir: join(tmp, "out") });
const evidence = evidenceFor(result, loadedNew.skill);
assert.equal(evidence.skill.digest, head.digest);
assert.equal(evidence.vsBaseline.gate.delta > 0, true);

// Stage a candidate with its suite, then bench it against the current version.
const staged = await stageCandidate(loadedNew.skill, join(tmp, "staged"), { version: "1.2.0", withSuite: true });
writeFileSync(join(staged.dir, "SKILL.md"), skillMd("1.2.0", "second"));
const candidate = await loadSkill(staged.dir);
const loadedOld = await loadSkillByDigest(old.digest, [gsrc]);
const proposal = await benchProposal({ current: loadedOld.skill, candidate, suite, adapter, outDir: join(tmp, "out2") });
assert.equal(proposal.comparison.kind, "version-vs-version");
await loadedNew.dispose();
await loadedOld.dispose();
console.log("flow ok");
`;

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
    'import type { BenchProposal, BenchProposalOptions, BenchResult, BenchSkillOptions, ResumeBenchOptions } from "@grimoire/core";',
    "export type BenchTypes = [BenchSkillOptions, BenchProposalOptions, BenchProposal, BenchResult, ResumeBenchOptions];",
    "export const report: (r: BenchResult) => string = formatReport;",
    "export const bench: (o: BenchSkillOptions) => Promise<BenchResult> = benchSkill;",
    "export const propose: (o: BenchProposalOptions) => Promise<BenchProposal> = benchProposal;",
    "export const resume: (o: ResumeBenchOptions) => Promise<BenchResult> = resumeBench;",
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

  // (c) the consumer flow through the packed tarball, with a stub agent (no network, no LLM):
  // dirSource/gitSource (tagged history)/custom SkillSource -> resolveSkill -> loadSkillByDigest
  // -> benchSkill -> evidenceFor -> stageCandidate({withSuite}) -> benchProposal, plus a refused
  // digest mismatch and per-source error isolation.
  writeFileSync(join(app, "flow.mjs"), FLOW_SCRIPT);
  process.stdout.write(run("node", ["flow.mjs"], app));
  console.log("smoke-consume: PASS");
} catch (err) {
  failed = true;
  console.error("smoke-consume: FAIL");
  console.error(err instanceof Error ? err.message : err);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
