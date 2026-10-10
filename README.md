# grimoire-lab

Benchmark agent skills. Does a skill actually beat the same agent without it?

`grimoire bench` runs a skill's task suite twice, with the skill installed and without, in throwaway
workspaces, then compares pass rate, tokens, cost and time.

> Status: early. One agent (Claude Code). Comparisons: skill vs. no-skill baseline, and skill
> version vs. skill version.
> Planned: agent-vs-agent, an LLM judge, more adapters.

## Requirements

- Node 22.13+ and pnpm
- [Claude Code](https://claude.com/claude-code) CLI on `PATH`, logged in (or `ANTHROPIC_API_KEY` set)

## Usage

```sh
# once, from a clone: build and put `grimoire` on your PATH
pnpm install && pnpm build
(cd packages/cli && npm link)

# scaffold a skill (default location: .claude/skills/<name>) with a starter suite
grimoire new pdf-extract

# edit .claude/skills/pdf-extract/grimoire.bench.yaml, then:
grimoire bench .claude/skills/pdf-extract --repeat 3 --model haiku
grimoire report            # latest run; `report <id>` for an older one
```

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
grimoire bench .claude/skills/demo --against 1.0.0
# vs the last commit, any branch/tag/commit, or another directory
grimoire bench .claude/skills/demo --against HEAD
grimoire bench .claude/skills/demo --against ../old-checkout/demo
```

Both versions run the same suite (the one next to the skill you pass) and are labeled
`name@version`; if an edited skill kept its version, both labels get a `+digest` suffix. Git
sources are read from the repository containing the skill, at the same relative path, without
touching your working tree. There is no baseline in this mode. Identical contents are rejected.

A `results.db` from the first release (schema v1) is rejected with an error; delete it to start fresh.

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

Limits:

- The workspace isolates files, not the network or the rest of your filesystem. The agent runs with
  `--permission-mode bypassPermissions`; do not benchmark skills you do not trust.
- Credential isolation needs a `.credentials.json` in your Claude config dir (Windows/Linux) or
  `ANTHROPIC_API_KEY`. macOS keychain logins are not supported yet.
- Trials are non-deterministic and run sequentially; small repeat counts give noisy pass rates.
- Benchmarks consume your Claude plan's usage limits.

## Development

```sh
pnpm lint     # Biome
pnpm build    # tsc -b
pnpm test     # Vitest (agent calls are faked; no credentials needed)
pnpm coverage:changed [base]   # per-file >= 90% lines/statements/functions for files changed vs base (default origin/main); CI enforces this on PRs
```

Packages: `@grimoire/core` (skill/suite parsing, assertions, engine, SQLite store, report),
`@grimoire/adapters` (agent adapters; Claude Code), `@grimoire/cli`.

Adding an agent means implementing `AgentAdapter` from `@grimoire/core` (`detect`, `install`, `run`)
and registering it in `packages/adapters/src/index.ts`.

## License

MIT, see [LICENSE](LICENSE).
