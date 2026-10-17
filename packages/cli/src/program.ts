import { join, resolve } from "node:path";
import { getAdapter, loadCommandConfig } from "@grimoire/adapters";
import {
  type AgentAdapter,
  type BenchResult,
  benchProposal,
  benchSkill,
  buildVariants,
  DigestMismatch,
  dirSource,
  formatReport,
  formatTrialLine,
  gitSource,
  loadSkill,
  loadSkillByDigest,
  loadSuite,
  ResultStore,
  ResumeMismatch,
  resolveAgainst,
  resolveSkill,
  resumeBench,
  type Skill,
  SkillNotFound,
  type SkillSource,
} from "@grimoire/core";
import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_SKILLS_DIR, scaffoldSkill } from "./scaffold.js";

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

/** `resolveAdapter` is injectable so tests can bench without a real agent CLI. */
export function createProgram(
  log: (line: string) => void = console.log,
  resolveAdapter: (id: string, opts?: { config?: unknown }) => AgentAdapter = getAdapter,
): Command {
  const program = new Command("grimoire")
    .description("Benchmark agent skills against a no-skill baseline")
    .exitOverride();

  const logReport = (result: BenchResult, outDir: string) => {
    log("");
    log(formatReport(result));
    log(`\nSaved to ${join(outDir, "runs", result.id)}`);
  };

  /** `--agent-config` configures the generic `command` adapter; it is meaningless for any other. */
  const adapterFor = async (agent: string, agentConfig?: string): Promise<AgentAdapter> => {
    if (agentConfig === undefined) return resolveAdapter(agent);
    if (agent !== "command") {
      throw new Error(
        `--agent-config configures the command adapter: pass --agent command (got --agent ${agent})`,
      );
    }
    const config = await loadCommandConfig(agentConfig);
    if (config.skillDir === undefined) {
      log(
        "warning: the agent config has no skillDir, so skills are never installed: skill and baseline runs are identical and a comparison between them is not meaningful",
      );
    }
    return resolveAdapter(agent, { config });
  };

  program
    .command("new <name>")
    .description("Scaffold a skill with a starter benchmark suite")
    .option("--dir <path>", "parent directory for the skill", DEFAULT_SKILLS_DIR)
    .action(async (name: string, opts: { dir: string }) => {
      const dir = await scaffoldSkill(name, opts.dir);
      log(`Created ${dir}`);
    });

  program
    .command("bench <skillDir>")
    .description(
      "Benchmark a skill: against no skill by default, or against another version with --against",
    )
    .option("--suite <file>", "suite file (default: <skillDir>/grimoire.bench.yaml)")
    .option(
      "--against <dir|ref>",
      "compare with another skill directory, or a git ref/tag (a bare semver means tag <skill>@<semver>)",
    )
    .option("--repeat <n>", "trials per task and variant (overrides the suite)", positiveInt)
    .option("--concurrency <n>", "trials to run in parallel", positiveInt, 1)
    .option("--model <model>", "model passed to the agent")
    .option(
      "--agent <id>",
      "agent adapter (claude-code, or command with --agent-config)",
      "claude-code",
    )
    .option(
      "--agent-config <file>",
      "JSON or YAML config of the command adapter (requires --agent command)",
    )
    .option("--out <dir>", "output directory", ".grimoire")
    .action(
      async (
        skillDir: string,
        opts: {
          suite?: string;
          against?: string;
          repeat?: number;
          concurrency: number;
          model?: string;
          agent: string;
          agentConfig?: string;
          out: string;
        },
      ) => {
        const skill = await loadSkill(skillDir);
        const suite = await loadSuite(opts.suite ?? join(skill.dir, "grimoire.bench.yaml"));
        const adapter = await adapterFor(opts.agent, opts.agentConfig);
        const against = opts.against ? await resolveAgainst(skill, opts.against) : undefined;
        const outDir = resolve(opts.out);
        let store: ResultStore | undefined;
        try {
          const variants = buildVariants(skill, against?.skill);
          store = new ResultStore(join(outDir, "results.db"));
          const repeat = opts.repeat ?? suite.repeat;
          log(
            `${suite.name}: ${suite.tasks.length} task(s) x ${repeat} repeat(s) x ${variants.length} variants`,
          );
          const result = await benchSkill({
            skill,
            suite,
            adapter,
            against: against?.skill,
            repeat,
            concurrency: opts.concurrency,
            model: opts.model,
            outDir,
            store,
            onTrial: (t, arm) => log(formatTrialLine(t, arm)),
          });
          logReport(result, outDir);
        } finally {
          store?.close();
          await against?.cleanup();
        }
      },
    );

  program
    .command("propose <skillDir>")
    .description(
      "Benchmark a candidate version of a skill against the current one on the current skill's suite",
    )
    .requiredOption("--candidate <dir>", "directory of the edited candidate (see stageCandidate)")
    .option("--suite <file>", "suite file (default: <skillDir>/grimoire.bench.yaml)")
    .option("--repeat <n>", "trials per task and variant (overrides the suite)", positiveInt)
    .option("--concurrency <n>", "trials to run in parallel", positiveInt, 1)
    .option("--model <model>", "model passed to the agent")
    .option(
      "--agent <id>",
      "agent adapter (claude-code, or command with --agent-config)",
      "claude-code",
    )
    .option(
      "--agent-config <file>",
      "JSON or YAML config of the command adapter (requires --agent command)",
    )
    .option("--out <dir>", "output directory", ".grimoire")
    .action(
      async (
        skillDir: string,
        opts: {
          concurrency: number;
          candidate: string;
          suite?: string;
          repeat?: number;
          model?: string;
          agent: string;
          agentConfig?: string;
          out: string;
        },
      ) => {
        const current = await loadSkill(skillDir);
        const candidate = await loadSkill(opts.candidate);
        const suite = await loadSuite(opts.suite ?? join(current.dir, "grimoire.bench.yaml"));
        const adapter = await adapterFor(opts.agent, opts.agentConfig);
        const outDir = resolve(opts.out);
        const variants = buildVariants(candidate, current);
        const repeat = opts.repeat ?? suite.repeat;
        const store = new ResultStore(join(outDir, "results.db"));
        try {
          log(
            `${suite.name}: ${suite.tasks.length} task(s) x ${repeat} repeat(s) x ${variants.length} variants`,
          );
          const { result, comparison: c } = await benchProposal({
            current,
            candidate,
            suite,
            adapter,
            repeat,
            concurrency: opts.concurrency,
            model: opts.model,
            outDir,
            store,
            onTrial: (t, arm) => log(formatTrialLine(t, arm)),
          });
          logReport(result, outDir);
          const pp = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}pp`;
          const gate = `${c.gate.minTrials} trials per side and a pass-rate delta of at least ${(c.gate.tolerance * 100).toFixed(0)}pp`;
          log(`\nVerdict: ${c.verdict} (${c.subject} vs ${c.reference})`);
          log(
            `  pass rate ${pp(c.deltas.passRate)} · n ${c.n.subject} vs ${c.n.reference} (infra errors ${c.n.subjectErrors} vs ${c.n.referenceErrors}) · ${c.significant ? "significant" : "not significant"}: gate needs ${gate}`,
          );
        } finally {
          store.close();
        }
      },
    );

  program
    .command("resume <runId>")
    .description(
      "Finish an aborted or crashed run: runs only its missing trials, appends them to the same run and prints the report",
    )
    .option(
      "--suite <file>",
      "suite file (default: grimoire.bench.yaml of the newest skill in the run)",
    )
    .option(
      "--skill <dir>",
      "directory of a skill the run used (repeatable); others are looked up by digest",
      (dir: string, dirs: string[]) => [...dirs, dir],
      [] as string[],
    )
    .option("--dir <path>", "directory of skill folders to look skills up in", DEFAULT_SKILLS_DIR)
    .option(
      "--git <repo>",
      "also look skills up in this git repository (HEAD and name@semver tags); see --git-path",
    )
    .option("--git-path <path>", "skills directory inside the --git repository", DEFAULT_SKILLS_DIR)
    .option("--concurrency <n>", "trials to run in parallel", positiveInt, 1)
    .option("--agent <id>", "agent adapter (default: the one the run used)")
    .option(
      "--agent-config <file>",
      "JSON or YAML config of the command adapter (implies --agent command); its id must match the run's agent",
    )
    .option("--out <dir>", "output directory", ".grimoire")
    .action(
      async (
        runArg: string,
        opts: {
          suite?: string;
          skill: string[];
          dir: string;
          git?: string;
          gitPath: string;
          concurrency: number;
          agent?: string;
          agentConfig?: string;
          out: string;
        },
      ) => {
        const runId = positiveInt(runArg);
        const outDir = resolve(opts.out);
        const store = new ResultStore(join(outDir, "results.db"));
        const disposers: (() => Promise<void>)[] = [];
        try {
          const run = store.getRun(runId);
          if (!run) throw new Error(`No run with id ${runId}`);
          const sources: SkillSource[] = [dirSource(opts.dir)];
          if (opts.git) sources.push(gitSource({ repo: opts.git, path: opts.gitPath }));
          const skills: Skill[] = await Promise.all(opts.skill.map((d) => loadSkill(d)));
          for (const v of run.variants) {
            const digest = v.skillDigest;
            if (digest === undefined || skills.some((s) => s.digest === digest)) continue;
            try {
              const loaded = await loadSkillByDigest(digest, sources);
              disposers.push(loaded.dispose);
              skills.push(loaded.skill);
            } catch (err) {
              if (!(err instanceof SkillNotFound || err instanceof DigestMismatch)) throw err;
              throw new ResumeMismatch(
                "skill",
                `Run ${runId} variant "${v.label}" used skill ${v.skillName ?? "?"} ${digest}, which is not available any more (${err.message}). Point --skill, --dir or --git at the exact version.`,
              );
            }
          }
          const newest = run.variants.findLast((v) => v.skillDigest !== undefined);
          const newestSkill = skills.find((s) => s.digest === newest?.skillDigest);
          const suiteFile =
            opts.suite ?? (newestSkill ? join(newestSkill.dir, "grimoire.bench.yaml") : undefined);
          if (!suiteFile) throw new Error("Run has no skill arm to find a suite for: pass --suite");
          const suite = await loadSuite(suiteFile);
          const agent = opts.agent ?? (opts.agentConfig ? "command" : run.agent);
          let adapter: AgentAdapter;
          try {
            adapter = await adapterFor(agent, opts.agentConfig);
          } catch (err) {
            if (opts.agent !== undefined || opts.agentConfig !== undefined) throw err;
            throw new Error(
              `${err instanceof Error ? err.message : String(err)} (run ${runId} used agent "${run.agent}"; for a command-adapter run pass --agent-config <file>)`,
            );
          }
          log(`Resuming run ${runId} (${suite.name}) on ${adapter.id}`);
          const result = await resumeBench({
            runId,
            store,
            suite,
            skills,
            adapter,
            outDir,
            concurrency: opts.concurrency,
            onTrial: (t, arm) => log(formatTrialLine(t, arm)),
          });
          logReport(result, outDir);
        } finally {
          store.close();
          for (const dispose of disposers) await dispose();
        }
      },
    );

  program
    .command("resolve <ref>")
    .description(
      "Pin a skill reference (name, name@version, name@sha256:..., sha256:...) to its digest",
    )
    .option("--dir <path>", "directory of skill folders", DEFAULT_SKILLS_DIR)
    .option(
      "--git <repo>",
      "also search this git repository (HEAD and name@semver tags); see --git-path",
    )
    .option("--git-path <path>", "skills directory inside the --git repository", DEFAULT_SKILLS_DIR)
    .action(async (ref: string, opts: { dir: string; git?: string; gitPath: string }) => {
      const sources: SkillSource[] = [dirSource(opts.dir)];
      if (opts.git) sources.push(gitSource({ repo: opts.git, path: opts.gitPath }));
      const pinned = await resolveSkill(ref, sources);
      log(`${pinned.name}${pinned.version ? `@${pinned.version}` : ""} ${pinned.digest}`);
    });

  program
    .command("report [run]")
    .description("Print the summary of a saved run (default: latest)")
    .option("--out <dir>", "output directory", ".grimoire")
    .option("--json", "print the run as a BenchResult JSON document")
    .action(async (runArg: string | undefined, opts: { out: string; json?: boolean }) => {
      const store = new ResultStore(join(resolve(opts.out), "results.db"));
      try {
        const id = runArg === undefined ? undefined : positiveInt(runArg);
        const result = id === undefined ? store.latestResult() : store.getResult(id);
        if (!result)
          throw new Error(id === undefined ? "No runs saved yet" : `No run with id ${id}`);
        log(opts.json ? JSON.stringify(result, null, 2) : formatReport(result));
      } finally {
        store.close();
      }
    });

  return program;
}
