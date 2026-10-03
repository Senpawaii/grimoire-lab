import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AssertionResult, evaluateAssertion } from "./assertions.js";
import type { Cell, ResultStore, TrialRecord } from "./store.js";
import type { ResolvedTask, Suite } from "./suite.js";
import type { AgentAdapter, RunResult, Skill } from "./types.js";
import { createWorkspace, destroyWorkspace } from "./workspace.js";

export interface BenchOptions {
  skill: Skill;
  suite: Suite;
  adapter: AgentAdapter;
  store: ResultStore;
  /** Transcripts and raw logs are written under `<outDir>/runs/<runId>/`. */
  outDir: string;
  /** Overrides the suite's repeat count. */
  repeat?: number;
  model?: string;
  cells?: Cell[];
  onTrial?: (trial: TrialRecord) => void;
}

const ALL_CELLS: Cell[] = ["baseline", "with-skill"];

async function runTrial(
  o: BenchOptions,
  task: ResolvedTask,
  cell: Cell,
  repeatIdx: number,
  runDir: string,
  runRel: string,
): Promise<TrialRecord> {
  const stem = `${cell}__${task.id}__${repeatIdx}`;
  const ws = await createWorkspace(task.fixturesDir);
  let result: RunResult;
  let assertions: AssertionResult[] = [];
  const started = Date.now();
  try {
    if (cell === "with-skill") await o.adapter.install(o.skill, ws);
    result = await o.adapter.run(
      { prompt: task.prompt, timeoutMs: task.timeoutMs, model: o.model },
      ws,
    );
    if (result.status === "completed") {
      const ctx = { ws, result, skill: cell === "with-skill" ? o.skill : undefined };
      assertions = await Promise.all(task.assertions.map((a) => evaluateAssertion(a, ctx)));
    }
  } catch (err) {
    result = {
      status: "error",
      transcript: [],
      finalMessage: "",
      durationMs: Date.now() - started,
      rawOutput: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await destroyWorkspace(ws);
  }

  await writeFile(
    join(runDir, `${stem}.jsonl`),
    result.transcript.map((e) => JSON.stringify(e)).join("\n"),
  );
  await writeFile(join(runDir, `${stem}.raw.txt`), result.rawOutput);

  return {
    cell,
    taskId: task.id,
    repeatIdx,
    status: result.status,
    passed: result.status === "completed" && assertions.every((a) => a.passed),
    tokens: result.usage?.tokens,
    costUsd: result.usage?.costUsd,
    durationMs: result.durationMs,
    finalMessage: result.finalMessage,
    error: result.error,
    transcriptPath: `${runRel}/${stem}.jsonl`,
    assertions,
  };
}

/**
 * Runs every (task, repeat, cell) trial sequentially and returns the run id. Cells are
 * interleaved within each repeat so drift (rate limits, load) hits both equally.
 */
export async function runBench(o: BenchOptions): Promise<number> {
  const detected = await o.adapter.detect();
  if (!detected.available)
    throw new Error(`Agent "${o.adapter.id}" is not available on this machine`);

  const cells = o.cells ?? ALL_CELLS;
  const repeat = o.repeat ?? o.suite.repeat;
  const runId = o.store.createRun({
    suite: o.suite.name,
    skillName: o.skill.name,
    skillVersion: o.skill.version,
    skillDigest: o.skill.digest,
    agent: o.adapter.id,
    agentVersion: detected.version,
    model: o.model,
  });
  const runRel = `runs/${runId}`;
  const runDir = join(o.outDir, runRel);
  await mkdir(runDir, { recursive: true });

  for (const task of o.suite.tasks) {
    for (let i = 1; i <= repeat; i++) {
      for (const cell of cells) {
        const trial = await runTrial(o, task, cell, i, runDir, runRel);
        o.store.addTrial(runId, trial);
        o.onTrial?.(trial);
      }
    }
  }
  return runId;
}
