import { join, resolve } from "node:path";
import { getAdapter } from "@grimoire/adapters";
import {
  type AgentAdapter,
  formatReport,
  formatTrialLine,
  loadSkill,
  loadSuite,
  ResultStore,
  runBench,
} from "@grimoire/core";
import { Command, InvalidArgumentError } from "commander";
import { scaffoldSkill } from "./scaffold.js";

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

/** `resolveAdapter` is injectable so tests can bench without a real agent CLI. */
export function createProgram(
  log: (line: string) => void = console.log,
  resolveAdapter: (id: string) => AgentAdapter = getAdapter,
): Command {
  const program = new Command("grimoire")
    .description("Benchmark agent skills against a no-skill baseline")
    .exitOverride();

  program
    .command("new <name>")
    .description("Scaffold a skill with a starter benchmark suite")
    .option("--dir <path>", "parent directory for the skill", join(".claude", "skills"))
    .action(async (name: string, opts: { dir: string }) => {
      const dir = await scaffoldSkill(name, opts.dir);
      log(`Created ${dir}`);
    });

  program
    .command("bench <skillDir>")
    .description("Run the skill's benchmark suite with and without the skill")
    .option("--suite <file>", "suite file (default: <skillDir>/grimoire.bench.yaml)")
    .option("--repeat <n>", "trials per task and cell (overrides the suite)", positiveInt)
    .option("--model <model>", "model passed to the agent")
    .option("--agent <id>", "agent adapter", "claude-code")
    .option("--out <dir>", "output directory", ".grimoire")
    .action(
      async (
        skillDir: string,
        opts: { suite?: string; repeat?: number; model?: string; agent: string; out: string },
      ) => {
        const skill = await loadSkill(skillDir);
        const suite = await loadSuite(opts.suite ?? join(skill.dir, "grimoire.bench.yaml"));
        const adapter = resolveAdapter(opts.agent);
        const outDir = resolve(opts.out);
        const store = new ResultStore(join(outDir, "results.db"));
        try {
          const repeat = opts.repeat ?? suite.repeat;
          log(`${suite.name}: ${suite.tasks.length} task(s) x ${repeat} repeat(s) x 2 cells`);
          const runId = await runBench({
            skill,
            suite,
            adapter,
            store,
            outDir,
            repeat,
            model: opts.model,
            onTrial: (t) => log(formatTrialLine(t)),
          });
          const run = store.getRun(runId);
          if (!run) throw new Error(`Run ${runId} vanished from the store`);
          log("");
          log(formatReport(run, store.listTrials(runId)));
          log(`\nSaved to ${join(outDir, "runs", String(runId))}`);
        } finally {
          store.close();
        }
      },
    );

  program
    .command("report [run]")
    .description("Print the summary of a saved run (default: latest)")
    .option("--out <dir>", "output directory", ".grimoire")
    .action(async (runArg: string | undefined, opts: { out: string }) => {
      const store = new ResultStore(join(resolve(opts.out), "results.db"));
      try {
        const id = runArg === undefined ? undefined : positiveInt(runArg);
        const run = store.getRun(id);
        if (!run) throw new Error(id === undefined ? "No runs saved yet" : `No run with id ${id}`);
        log(formatReport(run, store.listTrials(run.id)));
      } finally {
        store.close();
      }
    });

  return program;
}
