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
  `compareArms`. `benchSkill` is still to come: see design doc section 1.
- Skill catalog and digest-pinned resolution across sources (#14): `SkillRef`, `resolveSkill`,
  `loadSkillByDigest`, `dirSource`, `gitSource`.
- Version proposals (#17): `proposeVersion(skill, basis, { rewriter })` with an injected
  `SkillRewriter`, typed `RewriterNotAvailable`/`NoChange`, and `stageCandidate` (design doc section 6).
  `benchProposal` is still to come.
