import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AssertionResult, evaluateAssertion } from "./assertions.js";
import type { ResultStore, TrialRecord } from "./store.js";
import type { ResolvedTask, Suite } from "./suite.js";
import type { AgentAdapter, RunResult } from "./types.js";
import type { Variant } from "./variants.js";
import { createWorkspace, destroyWorkspace } from "./workspace.js";

export interface BenchOptions {
  suite: Suite;
  /** Compared arms, run in this order within every repeat. Labels must be unique. */
  variants: Variant[];
  adapter: AgentAdapter;
  store: ResultStore;
  /** Transcripts and raw logs are written under `<outDir>/runs/<runId>/`. */
  outDir: string;
  /** Overrides the suite's repeat count. */
  repeat?: number;
  model?: string;
  onTrial?: (trial: TrialRecord) => void;
}

const fileStem = (variant: string, taskId: string, repeatIdx: number) =>
  `${variant.replace(/[^\w.@+-]/g, "_")}__${taskId}__${repeatIdx}`;

async function runTrial(
  o: BenchOptions,
  task: ResolvedTask,
  variant: Variant,
  repeatIdx: number,
  runDir: string,
  runRel: string,
): Promise<TrialRecord> {
  const stem = fileStem(variant.label, task.id, repeatIdx);
  const ws = await createWorkspace(task.fixturesDir);
  let result: RunResult;
  let assertions: AssertionResult[] = [];
  const started = Date.now();
  try {
    if (variant.skill) await o.adapter.install(variant.skill, ws);
    result = await o.adapter.run(
      { prompt: task.prompt, timeoutMs: task.timeoutMs, model: o.model },
      ws,
    );
    if (result.status === "completed") {
      const ctx = { ws, result, skill: variant.skill };
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
    variant: variant.label,
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
 * Runs every (task, repeat, variant) trial sequentially and returns the run id. Variants are
 * interleaved within each repeat so drift (rate limits, load) hits all of them equally.
 */
export async function runBench(o: BenchOptions): Promise<number> {
  const labels = o.variants.map((v) => v.label);
  if (labels.length < 2) throw new Error("A benchmark needs at least two variants to compare");
  if (new Set(labels).size !== labels.length) {
    throw new Error(`Variant labels must be unique, got: ${labels.join(", ")}`);
  }

  const detected = await o.adapter.detect();
  if (!detected.available)
    throw new Error(`Agent "${o.adapter.id}" is not available on this machine`);

  const repeat = o.repeat ?? o.suite.repeat;
  const runId = o.store.createRun({
    suite: o.suite.name,
    agent: o.adapter.id,
    agentVersion: detected.version,
    model: o.model,
    variants: o.variants.map((v) => ({
      label: v.label,
      skillName: v.skill?.name,
      skillVersion: v.skill?.version,
      skillDigest: v.skill?.digest,
    })),
  });
  const runRel = `runs/${runId}`;
  const runDir = join(o.outDir, runRel);
  await mkdir(runDir, { recursive: true });

  for (const task of o.suite.tasks) {
    for (let i = 1; i <= repeat; i++) {
      for (const variant of o.variants) {
        const trial = await runTrial(o, task, variant, i, runDir, runRel);
        o.store.addTrial(runId, trial);
        o.onTrial?.(trial);
      }
    }
  }
  return runId;
}
