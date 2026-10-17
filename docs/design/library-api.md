# Design: grimoire-lab as a library (Heartwood integration)

Status: proposal. Heartwood depends on `@grimoire/core`; grimoire-lab never depends on Heartwood.

## Starting point (what exists)

- `loadSkill(dir)` -> `Skill {dir, name, version?, digest}`; `digestDir` is a content digest
  (`sha256:`, LF-normalized, excludes `grimoire.bench.yaml`, `fixtures/`, `.git`).
- `runBench({suite, variants, adapter, store, outDir, ...})` returns a run id; results live only
  in SQLite (`ResultStore`) and are read back as `RunRecord` + `TrialRecord[]`.
- `buildVariants(current, against?)` makes the arms: baseline vs skill, or version vs version.
- `resolveAgainst` resolves a dir / git ref / tag to a `Skill` (exports git trees to a temp dir).
- The orchestration (load skill, load suite, resolve against, store, report) lives in
  `packages/cli/src/program.ts`, not in core.

Gaps against the six requirements: no result object (only DB rows), no comparison data, no
agent-vs-agent, no skill refs/sources/digest loading, no proposal flow, and the CLI owns the
orchestration.

## Principles

1. Core exposes functions that take explicit inputs and return plain, JSON-serializable values.
   No global config, no `process.cwd()` assumptions, no printing.
2. Core never imports `@grimoire/adapters`. Callers pass an `AgentAdapter` instance (CLI and
   Heartwood both do the wiring).
3. grimoire-lab reports measurements. It does not decide ranks or promotions.
4. Content digest is the identity of a skill. Names and versions are labels.

## 1. Programmatic API

New high-level entry points in `@grimoire/core` (new file `bench.ts`); `runBench` stays as the
low-level engine.

```ts
interface BenchSkillOptions {
  skill: Skill;                 // already loaded (see sources, section 4)
  suite: Suite;
  adapter: AgentAdapter;
  against?: Skill;              // version-vs-version arm
  baseline?: boolean;           // add a no-skill arm; default: true unless `against` is set (today's CLI behavior)
  repeat?: number; model?: string;
  outDir: string;               // transcripts
  store?: ResultStore;          // optional persistence
  onTrial?: (t: TrialResult) => void;
  signal?: AbortSignal;
}
function benchSkill(o: BenchSkillOptions): Promise<BenchResult>;
```

- The CLI `bench` action becomes: load skill/suite, `resolveAgainst`, `getAdapter`, `benchSkill`,
  `formatReport(result)`. `formatReport`/`summarize` take a `BenchResult`, so CLI and library print
  from the same data.
- `ResultStore` gains `getResult(id): BenchResult` and `latestResult()`; it persists the result
  and no longer needs consumers to reassemble rows. The SQLite schema version is internal and is
  independent of the result schema version below.
- `onTrial` is the only progress hook; `AbortSignal` is the only cancellation mechanism.
- Everything public is exported from `index.ts`; nothing under `dist/*` is part of the API.

## 2. Benchmark result schema (versioned)

Defined once in `result.ts` as zod schemas, with TS types inferred from them
(`z.infer`). Exported: `BenchResultSchema`, `parseBenchResult(json)`, and the types. Consumers
that persist results can re-validate on read.

```ts
const SCHEMA_VERSION = 1;

interface BenchResult {
  schemaVersion: 1;
  id: string;                    // store id as a string; stable key for consumers
  startedAt: string;             // ISO
  suite: { name: string; digest: string; taskIds: string[] };   // digest of the suite file + fixtures
  repeat: number;
  arms: ArmResult[];             // run order
  comparisons: Comparison[];     // computed within this run
}

interface ArmResult {
  label: string;                 // unique within the result
  agent: { id: string; version?: string; model?: string };  // on the arm, so agent-vs-agent needs no schema change
  skill?: SkillRef;              // absent = baseline
  score: Score;                  // overall
  tasks: TaskResult[];
}

interface Score {
  trials: number;
  passes: number;
  passRate: number;              // 0..1 over ALL trials; errors and timeouts count as failures
  errors: number;                // trials with infraError (adapter crash, rate limit, judge failure)
  meanJudgeScore?: number;       // 1..5, only if judged
  meanTokens?: number; meanDurationMs: number; meanCostUsd?: number;
}

interface TaskResult {
  taskId: string;
  score: Score;
  trials: TrialResult[];         // today's TrialRecord, minus the variant field; adds `infraError`
}
```

**Overall score = `arm.score.passRate`**: pooled passes / trials. It is a plain, explainable number.
grimoire-lab does not invent a composite of pass rate, cost, and judge score; those are separate
fields, so consumers weigh them as they like. Per-task `Score` lets a consumer see whether a high
overall rate hides a failing task.

**Infrastructure errors vs skill failures.** `passRate` is unchanged (all trials in the denominator), so
it stays simple and additive. Each `TrialResult` carries `infraError: boolean`, and `Score.errors` counts
them. A trial is an infra error when the harness could not measure the skill: adapter crash or
`RunResult.status === "error"`, a rate limit, or a failed judge call. Adapters set `RunResult.errorKind`
(`"infrastructure"` default for `status: "error"`). A timeout is a skill failure, not an infra error: a skill that
makes the agent loop should lose. Consumers compute `passes / (trials - errors)` to exclude infra errors,
and should treat a high `errors / trials` as "inconclusive", not as low rank. `Comparison.n` carries both
sides' error counts for the same reason.

### Comparisons

```ts
interface Comparison {
  kind: "skill-vs-baseline" | "version-vs-version" | "agent-vs-agent";
  subject: string;               // arm label (the thing being evaluated: skill / newer version / agent A)
  reference: string;             // arm label (baseline / older version / agent B)
  deltas: {                      // subject minus reference
    passRate: number;
    meanJudgeScore?: number;
    meanTokens?: number; meanDurationMs: number; meanCostUsd?: number;
  };
  tasks: { taskId: string; passRateDelta: number }[];
  n: { subject: number; reference: number;
       subjectErrors: number; referenceErrors: number };   // trials and infra errors, so consumers can demand a minimum sample
  comparable: true;              // see below
}
```

- `kind` is derived from what differs between the two arms (`deriveKind(a, b)`): no skill on the
  reference -> skill-vs-baseline; same skill name, different digest, same agent -> version-vs-version;
  same skill digest (or both baseline), different agent or model -> agent-vs-agent. Anything else throws.
- Pure function `compareArms(subject: ArmResult, reference: ArmResult): Comparison`. It requires
  matching `suite.digest` and `repeat`-independent task ids, and throws on a mismatch.
- Same-run comparisons are precomputed into `BenchResult.comparisons`. The default arms are
  baseline/skill, or older/newer version. Optional third arm: baseline plus both versions gives three comparisons.
- **Agent vs agent** is not a single run today (one adapter per run). Two supported ways, one schema:
  1. `benchSkill` per agent, then `compareArms(a.arms[i], b.arms[j])`. Works across runs and
     machines because arms are self-describing (agent, skill digest) and suite digest is checked.
  2. Later, if interleaving across agents matters, `benchSkill` can accept several adapters. This
     only fills `arms[].agent` differently; the schema does not change. Not built now.
- No significance test or confidence interval in v1, so consumers MUST gate on `n` and a minimum delta
  (see Consumer contract). `n` is given, and per-trial data stays in `TaskResult.trials` so a consumer can
  compute its own interval. An optional `ci` field later is additive.

### Versioning policy

`schemaVersion` is a literal in every serialized result. Additive optional fields do not bump it.
A rename, removal, or semantic change bumps it, and `parseBenchResult` then accepts only known
versions (and may upgrade old ones). Tests check a checked-in golden JSON fixture per version.

## 3. Skill pinning and digest resolution

```ts
interface SkillRef { name: string; version?: string; digest: string; source?: string }

// Reference grammar accepted by resolveSkill:
//   "name" | "name@1.2.0" | "name@sha256:<hex>" | "sha256:<hex>"
function resolveSkill(ref: string, sources: SkillSource[]): Promise<SkillRef>;
function loadSkillByDigest(digest: string, sources: SkillSource[]): Promise<LoadedSkill>;

interface LoadedSkill { skill: Skill; dispose(): Promise<void> }  // dispose removes temp files from git/remote sources
```

- `resolveSkill` is the "pin" operation: a loose ref (`name`, `name@1.2.0`) becomes
  a `SkillRef` with an exact digest. Ambiguity (several sources or versions match) throws unless
  the ref is already a digest. First match in source order is not used silently.
- `loadSkillByDigest` asks each source for the content and **re-computes the digest after
  materializing**. A mismatch throws. So a pinned digest always yields exactly that content, or fails.
- The digest function does not change (`digestDir`). It deliberately excludes the suite and fixtures, so
  `BenchResult.suite.digest` records the suite identity separately: a result pins (skill digest, suite digest, agent).
- Heartwood stores `SkillRef` and calls `loadSkillByDigest` to reproduce.

## 4. Skill sources

```ts
interface SkillSource {
  id: string;
  list(): Promise<(SkillRef & { description: string })[]>;
  load(digest: string): Promise<LoadedSkill | undefined>;   // undefined = not here
}
function dirSource(path: string, opts?: { id?: string }): SkillSource;
function gitSource(o: { repo: string; path?: string; id?: string }): SkillSource;
```

- `dirSource`: a directory of skill folders (for example `grimoire/skills`, the CLI default; `.claude/skills` also works). This is the
  **local grimoire**. `list` scans and hashes; `load(digest)` finds the folder with that digest and
  returns it in place (`dispose` is a no-op). The index is cached per instance and invalidated by directory mtimes.
- `gitSource`: a local repo path or a cloned remote. It lists `name@semver` tags and the HEAD tree, and
  `load(digest)` exports the matching tree to a temp dir. `exportTree` is lifted from `against.ts`;
  `resolveAgainst` is reimplemented on top of a git source and keeps its CLI behavior.
- "External sources" = any `SkillSource`. Heartwood can implement the 2-method interface for its own
  stores. A remote-URL clone helper is out of scope until needed; callers clone, then use `gitSource`.
- Sources are read-only. Nothing in core writes to a source.

## 5. Rank derivation (consumer-owned)

grimoire-lab does not define, store, or name ranks. Ranks (Common/Extra/Unique/Ultimate) and
their thresholds live in Heartwood. Core's job is to make the inputs easy to read:

```ts
interface SkillEvidence {
  skill: SkillRef;
  score: Score;                              // the skill arm's overall score
  vsBaseline?: Comparison;                   // skill-vs-baseline
  vsPrevious?: Comparison;                   // version-vs-version, if benchmarked
  agent: ArmResult["agent"];
}
function evidenceFor(result: BenchResult, skill: SkillRef): SkillEvidence;
```

Heartwood then writes `deriveRank(evidence, thresholds)` with its own config (for example
`{extra: {minPassRate: .6, minLift: .1}, ...}`). Nothing in the schema assumes which metrics are used, and
`n` is included so thresholds can require a minimum sample. `evidenceFor` is a lookup over
existing fields, not a new data source. Core ships no rank code; the example above is for the doc only.

## 6. Version proposals

```ts
function stageCandidate(current: Skill, destDir: string, opts?: { version?: string }): Promise<Skill>;
// copies the skill's files (not the suite) to destDir; optionally rewrites frontmatter `version`.
// Whoever edits (a human or an LLM agent) edits destDir afterwards. Core does not generate content.

interface ProposeOptions extends Omit<BenchSkillOptions, "skill" | "against"> {
  current: Skill;
  candidate: Skill;              // loadSkill(destDir) after editing
  baseline?: boolean;            // default false; true adds a no-skill arm (3 arms, 3 comparisons)
}
interface Proposal {
  current: SkillRef; candidate: SkillRef;
  result: BenchResult;
  comparison: Comparison;        // kind "version-vs-version", subject = candidate, reference = current
}
function benchProposal(o: ProposeOptions): Promise<Proposal>;
```

- A candidate is identified by its digest. There is no registry or draft-state object. It is a
  `Skill` in a directory, so existing pinning and store logic apply unchanged.
- The suite is the **current** skill's suite, so both versions face identical tasks. `benchProposal` throws on
  identical digests (existing `buildVariants` check). `candidate.version === current.version` is allowed;
  labels get the `+digest` suffix as today.
- Promotion is the consumer's call: it reads `comparison.deltas`, applies its policy, and, if it
  accepts, moves the candidate into its own store. grimoire-lab never writes into the current skill's source.
- `benchProposal` is `benchSkill` with `against: current`, plus a typed return. It adds no extra engine path.

## Mapping to code

| Change | Where |
|---|---|
| `BenchResult`, `Score`, `Comparison`, zod schemas, `parseBenchResult` | new `core/src/result.ts` |
| `compareArms`, `deriveKind`, `evidenceFor` | new `core/src/compare.ts` |
| `benchSkill`, `benchProposal`, `stageCandidate` | new `core/src/bench.ts` (orchestration moved from `cli/program.ts`) |
| `SkillRef`, `resolveSkill`, `loadSkillByDigest`, `SkillSource`, `dirSource`, `gitSource` | new `core/src/sources.ts`; `against.ts` reuses the git source |
| `Variant` gains `agent` info; `runBench` returns data to build `BenchResult` | `variants.ts`, `engine.ts` |
| suite digest (suite file + fixtures) | `suite.ts` / `digest.ts` (new `digestSuite`) |
| `getResult`, `latestResult` | `store.ts` (internal schema bump + migration, as v2 -> v3 did) |
| `summarize`/`formatReport` take `BenchResult` | `report.ts` |
| CLI becomes a thin wrapper; default skills dir `grimoire/skills/` | `cli/program.ts`, `cli/scaffold.ts`, README |
| Packaging: `@grimoire/core` ESM build (`tsc -b` -> `dist/`), `exports`/`types` map, `files`; consumed via `file:` link until published. CI job: `pnpm pack` core, install the tarball into an empty temp project, and `import` every documented export plus a type-check of a sample consumer | `core/package.json`, `.github/workflows/ci.yml`, new `scripts/smoke-consume.mjs` |

CLI additions (thin): `grimoire propose <skillDir> --candidate <dir>`, `grimoire resolve <ref>`,
`grimoire report --json`. They only call the functions above.

## Deliberately not included

- Ranks, thresholds, promotion policy (Heartwood).
- Statistical tests, composite scores, weighting.
- Multi-adapter single runs (schema allows it later).
- A skill registry, remote fetching, publishing, or candidate draft storage.
- Plugin systems beyond the two interfaces `AgentAdapter` and `SkillSource`.

## Standalone guarantee

Nothing above references Heartwood. The CLI remains a complete consumer of the same API, so standalone
use is the integration test. A `README` section ("Using as a library") should show:
`dirSource` -> `resolveSkill` -> `benchSkill` -> `evidenceFor`.

## Decisions (resolved)

1. **Local grimoire**: a dedicated directory, not `.claude/skills` (Claude-specific; the tool is
   agent-generic). The CLI defaults to `grimoire/skills/` (or the project config value). `.claude/skills`
   stays usable through `dirSource(path)`. `grimoire new` scaffolds into the default directory; the CLI
   `--dir` option and the README must change with it. Heartwood passes its own sources.
2. **Overall score**: pooled pass rate. Per-task `Score` shows whether a high overall rate hides a failing task.
3. **Agent-vs-agent**: compared across runs. Arms record agent and model and `compareArms` checks the suite
   digest. Cross-run drift is real with LLM agents, so consumers must require a minimum `n`.

## Consumer contract (Heartwood)

- Promotion must not rely on a raw delta. Heartwood sets a minimum `n` and a minimum delta before it
  auto-promotes anything, and may compute its own interval from `TaskResult.trials`. An optional `ci`
  field on `Comparison` is a possible additive follow-up.
- `LabPort` should not have one `proposeVersion`, because core has no content generator by design. Split it
  in three: `stageCandidate`, then an Orca-run worker edits the staged directory, then `benchProposal`.
- Heartwood can implement an Orca-backed `AgentAdapter` and pass it to `benchSkill`, so benchmark runs
  go through supervised Orca workers. This works because the adapter is injected.
