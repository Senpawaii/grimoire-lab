# Changelog

All notable changes to `@grimoire/core` (and the CLI built on it). Format follows
[Keep a Changelog](https://keepachangelog.com/).

## Version policy

- `0.x`: a minor bump (`0.1` -> `0.2`) may contain breaking changes; a patch bump is bug fixes only.
- The benchmark result `schemaVersion` is versioned independently of the package. Additive optional
  fields do not bump it; a rename, removal, or semantic change does.
- `1.0.0` ships when the library API described in `docs/design/library-api.md` is stable. From then on
  semver applies normally.
- Only the package root export (`@grimoire/core`) is public API.

## Unreleased

## 0.2.0 - 2026-10-18

### Added

- `Comparison.ci` (#25): optional 95% Newcombe-Wilson interval for the pass-rate delta, computed in
  `compare` from the gate's countable trials (infra errors excluded by default), plus
  `newcombeInterval` and `ComparisonCiSchema`. New gate option `requireCiExcludesZero` (default
  false) makes `significant` also require the interval to exclude zero; it is recorded in
  `comparison.gate`. Additive: `schemaVersion` stays 1 and results without `ci` still parse.
  `formatReport` and CLI output are unchanged.
- Parallel trials (#24): `concurrency` option on `runBench`/`benchSkill`/`benchProposal` (CLI `bench` and
  `propose --concurrency <n>`, positive integer, default 1 = unchanged sequential behavior; invalid
  values throw a `RangeError` before a run is created). Trials start in the order task, repeat, arm
  through a bounded pool and are stored and reported in completion order; the `BenchResult` has the same
  shape and ordering. SQLite writes are synchronous transactions, and each trial already had its own
  workspace and file stem, so no new locking was needed. On abort the trials already running are not
  interrupted: they finish and are stored, no new trial starts, then the promise rejects with
  `signal.reason` (the same happens when `onTrial` or a store write throws; the first error is
  rethrown). At concurrency 1 this is the previous behavior.
- Resumable runs (#24): `resumeBench({ runId, store, suite, skills, adapter, outDir, concurrency?,
  onTrial?, signal? })` runs only the (arm, task, repeat) trials a stored run has no result for, appends
  them to the same run and returns the complete `BenchResult`; a complete run is returned untouched
  without calling the adapter. Model and repeat count come from the run. The suite digest, skill digests
  (matched by digest, extras ignored) and agent id must match what the run recorded, else the new typed
  `ResumeMismatch` (`kind`: `"suite" | "skill" | "agent"`) is thrown before anything runs. Runs recorded
  before suite digests (internal schema v3 and older) cannot be resumed. No schema change.
- CLI (#24): `grimoire resume <runId> [--skill <dir>...] [--dir] [--git --git-path] [--suite <file>]
  [--concurrency <n>] [--agent <id>] [--out <dir>]` finishes a stored run and prints the report.

## 0.1.0 - 2026-10-17

Library work for Heartwood integration (design: `docs/design/library-api.md`):

- Packaging (#18): `@grimoire/core` is an installable ESM package at `0.1.0` with `exports`/`types`,
  `files` (no tests or source maps), `engines` (`node >=22.13`), `license`, `repository`, and
  `sideEffects: false`. CI packs it, installs the tarball into a fresh project, and checks runtime
  imports and a typed consumer (`scripts/smoke-consume.mjs`). Not published to npm.
- Versioned zod schemas for `BenchResult`/`Comparison` (#15): `BenchResultSchema`, `parseBenchResult`
  (`schemaVersion: 1`), `buildBenchResult`, `ResultStore.getResult`/`latestResult`, `digestSuite`.
  `TrialRecord.infraError` and `RunResult.errorKind` separate harness failures from skill failures.
  The internal SQLite schema is now v4 (migrated in place; runs recorded before v4 cannot be read as a
  `BenchResult` because they have no suite digest).
- `compare(subject, reference, opts?)` (#16) with `verdict`/`significant` from a documented threshold
  gate (not a statistical test), `deriveKind`, `armRef`, `evidenceFor`. Replaces the design doc's
  `compareArms`.
- Skill catalog and digest-pinned resolution across sources (#14): `SkillRef`, `resolveSkill`,
  `loadSkillByDigest`, `dirSource`, `gitSource`.
- Version proposals (#17): `proposeVersion(skill, basis, { rewriter })` with an injected
  `SkillRewriter`, typed `RewriterNotAvailable`/`NoChange`, and `stageCandidate` (design doc section 6).
- `benchSkill` and `benchProposal` (#21): the orchestration that used to live in the CLI is now
  `benchSkill({ skill, suite, adapter, outDir, against?, baseline?, repeat?, model?, store?, onTrial?,
  signal? })`, which returns the `BenchResult` with its comparisons (baseline-vs-skill, or
  version-vs-version; three arms with `baseline: true`). Without a `store` it uses a private in-memory
  one. `signal` stops between trials and rejects with an `AbortError`; stored trials stay (`runBench`
  gained the same `signal` option). `benchProposal({ current, candidate, ... })` returns
  `{ current, candidate, result, comparison }` (candidate vs current). The proposal types are
  `BenchProposal`/`BenchProposalOptions`: `Proposal`/`ProposeOptions` already name `proposeVersion`'s.
- Breaking, `0.x` (#21): `formatReport(result)` and `summarize(result)` now take a `BenchResult`
  instead of `(run, trials)`, and `formatTrialLine(trial, arm)` takes a `TrialResult` plus the arm
  label (the CLI prints through them; output is unchanged). `onTrial` of `benchSkill` is
  `(trial: TrialResult, arm: string)`.
- CLI: `bench` calls `benchSkill`. New thin commands `grimoire propose <skillDir> --candidate <dir>`
  (report plus the candidate-vs-current verdict), `grimoire resolve <ref> [--dir] [--git <repo>
  --git-path]` (prints `name@version digest`) and `grimoire report --json` (the stored `BenchResult`).
- Breaking, CLI (#21): the default skills directory is now `grimoire/skills/` (was `.claude/skills/`) for
  `grimoire new` and `grimoire resolve`; `.claude/skills` still works with `--dir`. `grimoire bench`
  takes the skill path as before. `grimoire report` needs a run recorded with a suite digest
  (internal schema v4+); older runs fail with an explanatory error instead of printing.
