# grimoire-lab

Benchmark agent skills. Does a skill actually beat the same agent without it?

`grimoire bench` runs a skill's task suite twice, with the skill installed and without, in throwaway
workspaces, then compares pass rate, tokens, cost and time.

> Status: early. Claude Code and omp, plus any other CLI through the generic command adapter. Comparisons: skill vs. no-skill baseline, and skill
> version vs. skill version.
> Planned: agent-vs-agent, an LLM judge, more adapters.

## Requirements

- Node 22.13+ and pnpm
- [Claude Code](https://claude.com/claude-code) CLI on `PATH`, logged in (or `ANTHROPIC_API_KEY` set), or
  [omp](#omp-agent) with `--agent omp`

## Usage

```sh
# once, from a clone: build and put `grimoire` on your PATH
pnpm install && pnpm build
(cd packages/cli && npm link)

# scaffold a skill (default location: grimoire/skills/<name>) with a starter suite
grimoire new pdf-extract

# edit grimoire/skills/pdf-extract/grimoire.bench.yaml, then:
grimoire bench grimoire/skills/pdf-extract --repeat 3 --model haiku
grimoire report            # latest run; `report <id>` for an older one
grimoire report --json     # the run as a BenchResult JSON document
```

`grimoire/skills/` is the default skills directory (a local, agent-neutral grimoire). A skill in any
other directory works the same: pass its path to `bench`, or use `--dir .claude/skills` with `new` and
`resolve`.

The link points at `packages/cli/dist`, so rerun `pnpm build` after pulling or editing the code.
Remove it with `npm unlink -g @grimoire/cli`. Publishing to npm (for `npx`) is not set up yet.

Example output:

```
              pass rate  mean tokens  mean time  mean cost
baseline      0/3        23.8k        5s         $0.018
with-skill    3/3        81.8k        6s         $0.034
```

Results land in `.grimoire/` (gitignored): `results.db` (SQLite) plus per-trial transcripts under
`.grimoire/runs/<id>/`.

### Comparing versions

```sh
# working tree vs the tag demo@1.0.0 (a bare semver means the tag <skill>@<semver>)
grimoire bench grimoire/skills/demo --against 1.0.0
# vs the last commit, any branch/tag/commit, or another directory
grimoire bench grimoire/skills/demo --against HEAD
grimoire bench grimoire/skills/demo --against ../old-checkout/demo
```

Both versions run the same suite (the one next to the skill you pass) and are labeled
`name@version`; if an edited skill kept its version, both labels get a `+digest` suffix. Git
sources are read from the repository containing the skill, at the same relative path, without
touching your working tree. There is no baseline in this mode. Identical contents are rejected.

A `results.db` from the first release (schema v1) is rejected with an error; delete it to start fresh.
`report` reads runs as a `BenchResult`, so a run recorded before suite digests were stored (internal
schema v3 or older) cannot be reported; the error says so.

### Proposing a version

```sh
# benchmark an edited copy of a skill against the current one, on the current skill's suite
grimoire propose grimoire/skills/demo --candidate ../demo-candidate --repeat 5
```

Runs the candidate (`--candidate <dir>`, a skill folder without a suite is fine) and the current skill
as a version-vs-version comparison, prints the usual report, then the verdict of the candidate against
the current version (pass-rate delta, `n`, infra errors, and the threshold gate it was judged by).
Promotion is yours: the command only measures. Identical contents are rejected.

### Parallel trials and resuming

```sh
grimoire bench grimoire/skills/demo --repeat 5 --concurrency 4     # also on `propose`
grimoire resume 3                                                  # finish run 3 after an abort or crash
grimoire resume 3 --skill ../old-checkout/demo --concurrency 4
```

`--concurrency <n>` (positive integer, default 1) runs up to `n` trials at once. Starting order and
the result are the same as sequentially; only completion order (the per-trial lines) differs. Ctrl+C
is not a graceful abort in the CLI: a killed process leaves the trials stored so far, which is exactly
what `resume` picks up (a trial that was running when the process died is simply missing and is run
again).

`grimoire resume <runId>` runs only the trials of run `<runId>` that have no stored result, appends them
to that run, and prints the usual report. Everything it needs comes from the run and from your files
matching what was recorded: skills are found by digest (`--skill <dir>`, repeatable; otherwise
`--dir`, default `grimoire/skills`, and `--git <repo> --git-path`, as in `resolve`), the suite is the
one next to the newest skill unless you pass `--suite <file>`, and the agent and model are the
run's (`--agent` can only repeat the same agent). If the suite or a skill no longer matches its stored
digest, or the agent differs, it refuses with `ResumeMismatch` and runs nothing. Resuming a complete
run just prints its report.

### Pinning a skill

```sh
grimoire resolve pdf-extract                     # name, name@1.2.0, name@sha256:<hex> or sha256:<hex>
grimoire resolve pdf-extract@0.1.0 --dir .claude/skills
grimoire resolve pdf-extract@0.1.0 --git ../skills-repo --git-path grimoire/skills
# -> pdf-extract@0.1.0 sha256:3b1f...   (the digest is the skill's identity)
```

Searches the `--dir` directory (default `grimoire/skills`) and, with `--git <repo>`, the repository's
HEAD and `name@semver` tags under `--git-path`. Several different digests for one ref is an error:
pin it with a digest.

## Skill format

A skill is a folder with a `SKILL.md`, the same format Claude Code reads natively:

```
pdf-extract/
  SKILL.md              # frontmatter: name (kebab-case), description, optional version (semver)
  scripts/              # optional
  grimoire.bench.yaml   # benchmark suite (not installed into the agent, not part of the digest)
  fixtures/             # optional task inputs (same)
```

Unknown frontmatter keys are allowed. Each run records the skill's content digest (sha256 over its
files, line endings normalized), so results stay attributable to exact contents.

## Benchmark suite

```yaml
suite: pdf-extract-basic
defaults: { repeat: 3, timeoutMs: 180000 }
tasks:
  - id: extract-table
    prompt: "Extract the table from report.pdf into table.csv"
    fixtures: ./fixtures/extract-table      # copied into the workspace first
    assertions:
      - { type: file_exists, path: table.csv }
      - { type: file_contains, path: table.csv, regex: "Q3,\\d+" }
      - { type: command, run: "node check.js", exitCode: 0 }
      - { type: transcript_contains, tool: Bash, pattern: "pdftotext" }
      - { type: skill_loaded }              # skipped when there is no skill (baseline)
      - { type: max, metric: tokens, value: 40000 }   # tokens | durationMs | costUsd
```

A trial passes when every assertion passes. Errored and timed-out trials count as failures.
`tokens` = input + cache creation + cache read + output.

### LLM judge

For results that assertions cannot check (is the commit message faithful to the diff? does the body
explain why?), add an optional `judge` to a task. The judge scores the result 1-5 against your rubric,
and the trial passes only if every assertion passes **and** the score reaches `passScore`.

```yaml
    judge:
      rubric: "A 5 explains WHY the change was made instead of restating the diff, and invents nothing."
      passScore: 4              # default 4
      model: haiku              # optional
      files: [change.diff, COMMIT_MSG.txt]   # workspace files the judge reads
      commands: ["git log -1"]               # commands run in the workspace; output is shown to the judge
```

- Put everything mechanically checkable in assertions; use the judge only for the rest.
- The judge sees text only: the task prompt, the agent's final message, the listed files and command
  outputs, and the rubric. It runs with all tools disabled in a fresh empty workspace, and it is not
  told which variant produced the result, so it cannot be biased by the skill being present.
  Treat agent output as untrusted: the prompt tells the judge to ignore instructions inside it.
- Every completed trial is judged, even if an assertion failed, so mean scores are comparable across
  variants. The report adds a `judge` column (mean score) when any trial was judged.
- A judge that errors, times out or returns no valid score fails the trial, with the reason shown.
- Judge calls use the same agent and your plan's quota (one extra call per trial) and are not counted
  in the trial's tokens, cost or time. Judging is itself non-deterministic; keep rubrics concrete.

A `results.db` from schema v2 is upgraded in place; v1 databases are still refused.

## How a trial runs

1. Fresh temp workspace, seeded from the task's `fixtures`.
2. With-skill cell only: skill copied to `.claude/skills/<name>/` in the workspace.
3. `claude -p` runs in the workspace with `CLAUDE_CONFIG_DIR` pointing at a scratch directory (only
   your login credentials are copied in), so your own skills, settings and hooks cannot leak into the
   baseline.
4. Assertions run against the workspace and the normalized transcript.

Variants are interleaved within each repeat so drift (rate limits, load) affects all of them equally.
With `--concurrency` the same order is the order trials start in.

Limits:

- The workspace isolates files, not the network or the rest of your filesystem. The agent runs with
  `--permission-mode bypassPermissions`; do not benchmark skills you do not trust.
- Credential isolation needs a `.credentials.json` in your Claude config dir (Windows/Linux) or
  `ANTHROPIC_API_KEY`. macOS keychain logins are not supported yet.
- Trials are non-deterministic; small repeat counts give noisy pass rates. They run one at a time unless
  you pass `--concurrency`; parallel trials share your plan's rate limits and the machine, so a large
  value can add infrastructure errors and timeouts that a sequential run would not see.
- Benchmarks consume your Claude plan's usage limits.

## omp agent

`--agent omp` runs `omp` headless (`omp -p --no-session --mode json`) in
the trial workspace and needs `omp` on `PATH` with a model configured. The skill is installed at
`.omp/skills/<name>/`. Isolation is part of the measurement: the baseline arm runs with `--no-skills`, the skill
arm with `--skills <name>`, so your own skills cannot leak into either arm, and every run uses `--no-rules
--no-extensions --approval-mode yolo` (do not benchmark skills you do not trust). The transcript comes from omp's
JSON stream: tool calls, results, and `skill_loaded` when the agent reads `skill://<name>`, so the
`skill_loaded` assertion works. Tokens and cost are summed over the run's assistant messages.

Pick model and thinking effort in one selector: `--model anthropic/claude-sonnet-5-5:high`. The selector is
recorded as the arm's `agent.model`, so runs that differ only in effort stay distinguishable. A run where omp
never started the agent (unknown model, bad flag) or the model request failed (rate limit, auth) is an
infrastructure error, not a skill failure. On timeout the whole process tree is killed.

## Other agents (command adapter)

The `command` adapter runs any CLI as the agent, so you can benchmark agents other than Claude Code.
It is configured with a small JSON or YAML file:

```sh
grimoire bench grimoire/skills/pdf-extract --agent command --agent-config agent.yaml
```

`--agent-config` is accepted by `bench`, `propose` and `resume` and requires `--agent command` (for
`resume`, passing `--agent-config` alone implies it; the config's `id` must equal the run's agent).
Programmatically: `createCommandAdapter(config)` or `getAdapter("command", { config })` from
`@grimoire/adapters`.

> **Untested example.** The config below shows the shape for an OpenAI Codex-style CLI. The flags and
> the skills directory are illustrative and have not been run against a real Codex install: check your
> agent's own documentation.

```yaml
id: codex                    # stored as the agent id in results (default: command)
command: codex               # executable, spawned directly (no shell)
args: [exec, "{prompt}"]     # {prompt} is replaced by the task prompt
detect: codex --version      # availability probe; first output line is recorded as the version
skillDir: .codex/skills      # workspace-relative dir the skill is copied into
modelArg: --model            # optional: how --model reaches the agent
env:                         # added to the environment grimoire inherits
  CODEX_HOME: /tmp/grimoire-codex-home
```

| Field | Meaning |
| --- | --- |
| `command` | Required. Executable; run without a shell (on Windows, `.cmd`/`.exe` shims on `PATH` work). |
| `args` | Argument list. `{prompt}` is substituted inside every element that contains it. Required (somewhere) unless `promptVia: stdin`. |
| `promptVia` | `arg` (default) or `stdin`. With `stdin` the prompt is written to the agent's stdin and `{prompt}` is not allowed in `args`. |
| `env` | Extra environment variables. The agent inherits grimoire's whole environment; these are added on top and win on conflict. |
| `skillDir` | Workspace-relative directory (not absolute, no `..`) the skill folder is copied into as `<skillDir>/<skill name>/` in the with-skill cell (the suite and fixtures are left out). Omit it for agents without skill support. |
| `detect` | Command line (whitespace-split string, or an argv array for paths with spaces) run before a bench. Exit 0 means available; the first output line is recorded as the agent version. Omitted: the agent is assumed available and a missing executable shows up as an infrastructure error per trial. |
| `modelArg` | Optional, e.g. `--model`. See "model and tools" below. |
| `maxOutputChars` | Cap on stdout and on stderr, in characters (default 10,000,000). |
| `id` | Optional adapter id recorded in results. Compare runs of the same agent under the same id. |

What a trial does: the agent runs in the trial workspace with the suite's timeout, with stdin closed
unless `promptVia: stdin`.

| Outcome | `status` | Counts against the skill? |
| --- | --- | --- |
| Exit code 0 | `completed`; final message = stdout, transcript = one assistant message holding stdout | |
| Non-zero exit, killed by a signal, or output over `maxOutputChars` (the agent is stopped) | `error`, `errorKind: agent` | yes |
| Timeout | `timeout` | yes |
| Executable not found / cannot be spawned | `error`, `errorKind: infrastructure` | no (inconclusive) |

Design decisions:

- **Prompt substitution is argv replacement.** The prompt becomes one argument; it is never
  interpolated into a shell command, so quotes, `$(...)`, backticks and newlines in a prompt cannot
  inject commands. Mind the agent's own parsing: a prompt starting with `-` can look like a flag (put
  a `--` before `{prompt}` in `args` if the agent supports it), and Windows limits a command line to
  about 32k characters (use `promptVia: stdin` for long prompts).
- **Environment.** The agent inherits the full environment of the `grimoire` process plus `env`.
  Unlike Claude Code there is no isolation: the agent's own configuration (skills, memory, hooks) can
  leak into the baseline. Point the agent's config-home variable at a scratch directory through `env`
  if it has one.
- **`model` and `tools` are ignored by default.** `--model` is only used when the config declares
  `modelArg`: then `[modelArg, model]` is appended after `args` (the model argument is a separate
  argv element, so `--model=x` forms are not supported). Without `modelArg` the model is not passed
  and results do not record one. A suite task's `tools` restriction is never passed: tool restriction
  is agent-specific, so a task that depends on it cannot be enforced through this adapter.
- **No token or cost data.** `usage` is undefined, so `max` assertions on `tokens`/`costUsd` fail
  with "agent reported no ..." and the report shows no tokens or cost for these runs.
- **`skill_loaded` cannot be evaluated.** The adapter has no transcript tool events, so it never
  emits a `skill_loaded` event: in the with-skill cell the assertion fails
  (`skill "<name>" was never invoked`); in the baseline cell it is skipped as always. Do not use
  `skill_loaded` in suites you run through this adapter, and judge on outcomes (files, commands)
  instead. `transcript_contains` only sees the agent's stdout.
- **No skill support = no skill-vs-baseline.** Without `skillDir` the install step does nothing, the
  two arms are identical, and a skill-vs-baseline comparison is meaningless (the CLI prints a
  warning). Such an agent is only useful as an agent-vs-agent data point on the same suite.

## Using as a library

`@grimoire/core` is an ESM package with bundled types (Node 22.13+). It is not published to npm yet;
install it from a clone or from git:

```sh
# from a local clone: build, then pack and install the tarball (what CI's smoke test does)
pnpm build && pnpm --filter @grimoire/core pack --pack-destination /tmp
pnpm add /tmp/grimoire-core-<version>.tgz

# or link the built package directly
pnpm add file:../grimoire-lab/packages/core
```

Once published, `pnpm add @grimoire/core` is the same import. The stable entry point is the package
root only. Pin a skill from your local grimoire, benchmark it, and read the evidence:

```ts
import { join } from "node:path";
import {
  type AgentAdapter,
  benchSkill,
  dirSource,
  evidenceFor,
  loadSkillByDigest,
  loadSuite,
  resolveSkill,
} from "@grimoire/core";

declare const adapter: AgentAdapter; // yours: an adapter from @grimoire/adapters, or your own

// 1. Pin: a loose ref becomes an exact digest (the skill's identity).
const sources = [dirSource("grimoire/skills")]; // or ".claude/skills", or your own SkillSource
const ref = await resolveSkill("pdf-extract@0.1.0", sources);

// 2. Load exactly that content (the digest is re-checked), run it, then clean up temp files.
const loaded = await loadSkillByDigest(ref.digest, sources);
try {
  const suite = await loadSuite(join(loaded.skill.dir, "grimoire.bench.yaml"));
  const result = await benchSkill({
    skill: loaded.skill,
    suite,
    adapter, // injected: core never imports an adapter
    outDir: ".grimoire", // transcripts
    repeat: 5,
    signal: AbortSignal.timeout(60 * 60 * 1000), // optional; no new trial starts after it fires
  });

  // 3. `result` is a plain, JSON-serializable BenchResult; evidenceFor looks up one skill's numbers.
  const evidence = evidenceFor(result, ref);
  console.log(evidence.score.passRate, evidence.vsBaseline?.verdict, evidence.vsBaseline?.n);
} finally {
  await loaded.dispose();
}
```

`benchSkill({ skill, suite, adapter, outDir, against?, baseline?, repeat?, model?, concurrency?, store?,
onTrial?, signal? })` runs baseline vs the skill (default), or `against` vs the skill (version-vs-version, no
baseline unless `baseline: true`, which makes three arms and three comparisons). Without a `store`
the run is kept in a private in-memory database and the `BenchResult` is the only output; pass a
`ResultStore` to persist it (and to keep the trials of an aborted run). `onTrial(trial, armLabel)` is
the only progress hook.

`concurrency` (positive integer, default 1; anything else throws a `RangeError` before running) bounds
how many trials are in flight. Trials start in the order task, repeat, arm, so arms stay interleaved
within each repeat; they finish, are stored and reach `onTrial` in completion order, and the
`BenchResult` has the same shape and ordering as a sequential run. Your adapter must tolerate that many
simultaneous runs (each trial has its own workspace; the SQLite store is written synchronously, so
workers never interleave inside a write).

Aborting `signal` starts no new trial; trials already running are not interrupted, they finish and are
stored, and then the promise rejects with `signal.reason` (an `AbortError` for a plain `abort()`). The
same drain happens when `onTrial` or a store write throws: the first error is rethrown.

```ts
import { resumeBench } from "@grimoire/core";

// store: the ResultStore passed to the aborted/crashed benchSkill; runId: its run id (BenchResult.id)
const complete = await resumeBench({ runId: 1, store, suite, skills: [skill], adapter, outDir: ".grimoire" });
```

`resumeBench({ runId, store, suite, skills, adapter, outDir, concurrency?, onTrial?, signal? })` runs
only the (arm, task, repeat) trials the run has no stored result for, appends them to the same run
(transcripts go to the same `runs/<id>/`) and returns the complete `BenchResult`. The model and repeat
count come from the run. Before running anything it checks that the supplied `suite` still hashes to
the run's stored suite digest, that `skills` contains every skill digest the arms used (matched by
digest, extras ignored; load them fresh, see `loadSkillByDigest`) and that `adapter.id` is the run's
agent; otherwise it throws `ResumeMismatch` with `kind` `"suite"`, `"skill"` or `"agent"`. A run with
nothing missing is returned as is without calling the adapter, so resuming is idempotent. Stored
trials are never re-run, infrastructure errors included; runs recorded before suite digests were
stored (internal schema v3 and older) cannot be resumed.

### Sources across several stores

`resolveSkill`, `resolve`, `loadSkillByDigest`, `load` and `listSkills` take an optional last argument
`{ onSourceError }`. By default the first source that throws from `list`/`load` makes the call reject. With
`onSourceError(error, source)` that source is skipped, the callback reports it, and the other sources still
answer; a skipped source can hide matches (for example one half of an `AmbiguousSkill`), so surface what the
callback receives. `gitSource` keeps tagged versions cached for the life of the instance (tags are immutable),
so after a commit only HEAD is re-hashed. File-manager litter (`.DS_Store`, `Thumbs.db`, `desktop.ini`, at any
depth) is not part of a skill's digest; a UTF-8 BOM still is, because the digest is byte identity apart from
CRLF normalization of text files.

Everything public is exported from `packages/core/src/index.ts`; `exports` blocks deep imports, so
nothing under `dist/*` is API. Core never imports `@grimoire/adapters`: you pass an `AgentAdapter`
instance. See [docs/design/library-api.md](docs/design/library-api.md) for the full API.

**Version policy.** While the version is `0.x`, a minor bump may contain breaking changes and a
patch bump is fixes only. The benchmark result `schemaVersion` is versioned separately from the
package: additive optional fields do not bump it, a rename/removal/semantic change does. `1.0.0`
ships once the library API in the design doc is stable. See [CHANGELOG.md](CHANGELOG.md).

### Results

A benchmark run reads back as a plain, JSON-serializable `BenchResult` (`store.getResult(id)` /
`store.latestResult()`, or `buildBenchResult(run, trials, { suite })`). It records the agent, each arm's
skill ref (`name`, `version`, `digest`), the suite digest (`digestSuite`), per-task and overall `Score`s,
every trial, and the comparisons computed inside the run. Persist it as JSON and re-validate on read with
`parseBenchResult`.

**Stability promise.** Every result carries a literal `schemaVersion` (currently `1`). Adding an optional
field does not bump it, so readers must ignore fields they do not know (`parseBenchResult` strips them).
Renaming or removing a field, making an optional one required, or changing what a field means (for example
what `passRate` is computed over) bumps it. `parseBenchResult` accepts only known versions and throws for
the rest. A golden fixture per version is checked in. The SQLite schema behind `ResultStore` is internal
and versioned independently.

`passRate` is passes over *all* trials, so errors and timeouts count as failures. Each trial also carries
`infraError` (adapter crash, rate limit, or a failed judge call; adapters can set `RunResult.errorKind`
to `"agent"` to say the agent itself failed) and `Score.errors` counts them. A timeout is a skill failure,
not an infra error. Treat a high `errors / trials` as inconclusive, not as a low score.

### Comparing results

```ts
import { armRef, compare, evidenceFor } from "@grimoire/core";

const c = compare(armRef(candidate, "demo@1.1.0"), armRef(baseline, { digest: oldDigest }), {
  minTrials: 20,
  tolerance: 0.15,
});
c.verdict; // "better" | "same" | "worse"
evidenceFor(result, skillRef); // score + vsBaseline / vsPrevious comparisons for one skill
```

`compare(subject, reference, opts?)` takes arms (from any results, runs or machines) and throws
`SuiteMismatch` if their suite digests differ and `IncomparableArms` if the arms differ in more than one
way. It returns the deltas (subject minus reference), per-task deltas, `n` with error counts, and a `kind`
(`skill-vs-baseline`, `version-vs-version`, `agent-vs-agent`).

`significant` and `verdict` come from a **threshold gate, not a statistical test**: there is no p-value.
`significant` is true when both sides have at least `minTrials` countable trials
(pooled over all tasks; default 5) and the pass-rate delta is at least `tolerance` in absolute value
(default 0.1). `verdict` is `same` unless `significant`, then `better` or `worse` by the sign of the delta.
With `excludeInfraErrors` (default true) the gate uses `passes / (trials - errors)` and counts only
countable trials; `deltas` always use the plain `passRate`. The rule that produced a verdict is recorded
in `comparison.gate`. Five trials and a 0.1 delta is noisy with LLM agents: consumers must set their own
`minTrials`/`tolerance` (or opt in to `requireCiExcludesZero`, below) before auto-promoting anything.

`comparison.ci` is a 95% interval for the same pass-rate delta: `{ level: 0.95, method: "newcombe-wilson",
lower, upper }`. It is the Newcombe hybrid-score interval for the difference of two independent
proportions (a Wilson score interval per arm, combined), computed from the gate's countable trials (infra
errors left out under the default `excludeInfraErrors`). It stays within [-1, 1] and is well-defined at 0/n
and n/n. Trials are treated as independent draws pooled over tasks, which is an approximation. It is absent
when a side has no countable trials, and by itself changes nothing: `significant` keeps its definition.
Pass `requireCiExcludesZero: true` to additionally require `ci.lower > 0` or `ci.upper < 0` (recorded in
`comparison.gate`; default false). Results written before `ci` existed still parse, without it. The
human-readable report and CLI output do not show the interval.

**Which delta is the lift?** `comparison.gate.delta` is the pass-rate delta the verdict was judged on: it
follows `excludeInfraErrors`, so with the default it leaves infrastructure errors out. Use it as the lift
over no skill (`skill-vs-baseline`) or over the previous version. `comparison.deltas.passRate` is always the
plain pass rate over all trials, errors counted as failures; use it as a fallback when `gate.delta` is absent
(a side had no countable trials), and treat the two as different numbers when infra errors occurred.

The default `minTrials` of 5 is permissive for LLM agents. Set your own (and `tolerance`) on every comparison
used for a decision.

### Proposing a version

`stageCandidate(skill, dir, { version?, withSuite? })` copies a skill into `dir`. The suite
(`grimoire.bench.yaml`, `fixtures/`) is not part of the digest and is left behind unless `withSuite: true`,
which copies it too so the staged folder can be benchmarked again as a complete skill; the staged digest is the
same either way.

`proposeVersion(skill, basis, { rewriter })` stages a copy, runs your rewriter on it (for example an
LLM-driven agent that reads the `BenchResult`), and returns `{ dir, digest, changelog, skill }`. Core
generates no content: without a rewriter it throws `RewriterNotAvailable`, and if the rewriter changes
nothing it throws `NoChange`.

`benchProposal({ current, candidate, suite, adapter, outDir, baseline?, repeat?, model?, store?, onTrial?,
signal? })` then measures the candidate (`loadSkill(dir)` of the edited copy) against `current` on the
current skill's suite and returns `{ current, candidate, result, comparison }`: two `SkillRef`s, the
`BenchResult`, and the `version-vs-version` `Comparison` with the candidate as `subject` and the current
version as `reference`. `baseline: true` adds a no-skill arm (three comparisons in `result`). Identical
digests throw. Core never promotes anything: read `comparison.deltas`, `n` and `verdict`, apply your
own policy, and move the candidate into your own store if you accept it. The type is named
`BenchProposal` (not `Proposal`, which is what `proposeVersion` returns).

## Releasing

Releases are GitHub releases cut from tags; nothing is published to npm. Only `@grimoire/core` is
versioned (its `package.json` version is the repo version; the CLI and adapters stay `0.0.0`).

1. Bump `version` in `packages/core/package.json` and rename `## Unreleased` in `CHANGELOG.md` to
   `## <version> - <date>` (add a fresh empty `## Unreleased` above it). Merge via a PR.
2. Tag the merge commit and push the tag: `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` checks the tag equals the package version and has a changelog
   section, runs lint, build, tests and the consume smoke test, then creates the GitHub release with
   that changelog section as notes and the `@grimoire/core` tarball attached. Tags containing `-`
   (for example `v0.2.0-rc.1`) are marked pre-release.

Consume a release with `pnpm add https://github.com/Senpawaii/grimoire-lab/releases/download/v<version>/grimoire-core-<version>.tgz`.
Skill version tags (`<skill>@<semver>`, used by `--against`) are a separate namespace and do not trigger releases.

## Development

```sh
pnpm lint     # Biome
pnpm build    # tsc -b
pnpm test     # Vitest (agent calls are faked; no credentials needed)
pnpm coverage:changed [base]   # per-file >= 90% lines/statements/functions for files changed vs base (default origin/main); CI enforces this on PRs
```

Packages: `@grimoire/core` (skill/suite parsing, assertions, engine, SQLite store, report),
`@grimoire/adapters` (agent adapters; Claude Code and the generic command adapter), `@grimoire/cli`.

Adding an agent means implementing `AgentAdapter` from `@grimoire/core` (`detect`, `install`, `run`)
and registering it in `packages/adapters/src/index.ts`. For a CLI agent, the command adapter needs no code.

## License

MIT, see [LICENSE](LICENSE).
