# grimoire-lab

Benchmark agent skills. Does a skill actually beat the same agent without it?

`grimoire bench` runs a skill's task suite twice, with the skill installed and without, in throwaway
workspaces, then compares pass rate, tokens, cost and time.

> Status: early. One agent (Claude Code) and one comparison (skill vs. no-skill baseline).
> Planned: version-vs-version, agent-vs-agent, an LLM judge, more adapters.

## Requirements

- Node 22.13+ and pnpm
- [Claude Code](https://claude.com/claude-code) CLI on `PATH`, logged in (or `ANTHROPIC_API_KEY` set)

## Usage

```sh
pnpm install && pnpm build

# scaffold a skill (default location: .claude/skills/<name>) with a starter suite
node packages/cli/dist/bin.js new pdf-extract

# edit .claude/skills/pdf-extract/grimoire.bench.yaml, then:
node packages/cli/dist/bin.js bench .claude/skills/pdf-extract --repeat 3 --model haiku
node packages/cli/dist/bin.js report            # latest run; `report <id>` for an older one
```

Example output:

```
              pass rate  mean tokens  mean time  mean cost
baseline      0/3        23.8k        5s         $0.018
with-skill    3/3        81.8k        6s         $0.034
```

Results land in `.grimoire/` (gitignored): `results.db` (SQLite) plus per-trial transcripts under
`.grimoire/runs/<id>/`.

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
      - { type: skill_loaded }              # skipped in the baseline cell
      - { type: max, metric: tokens, value: 40000 }   # tokens | durationMs | costUsd
```

A trial passes when every assertion passes. Errored and timed-out trials count as failures.
`tokens` = input + cache creation + cache read + output.

## How a trial runs

1. Fresh temp workspace, seeded from the task's `fixtures`.
2. With-skill cell only: skill copied to `.claude/skills/<name>/` in the workspace.
3. `claude -p` runs in the workspace with `CLAUDE_CONFIG_DIR` pointing at a scratch directory (only
   your login credentials are copied in), so your own skills, settings and hooks cannot leak into the
   baseline.
4. Assertions run against the workspace and the normalized transcript.

Cells are interleaved within each repeat so drift (rate limits, load) affects both equally.

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
```

Packages: `@grimoire/core` (skill/suite parsing, assertions, engine, SQLite store, report),
`@grimoire/adapters` (agent adapters; Claude Code), `@grimoire/cli`.

Adding an agent means implementing `AgentAdapter` from `@grimoire/core` (`detect`, `install`, `run`)
and registering it in `packages/adapters/src/index.ts`.
