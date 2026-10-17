import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AssertionResult, evaluateAssertion } from "./assertions.js";
import { runJudge } from "./judge.js";
import type { ResultStore, TrialRecord } from "./store.js";
import type { ResolvedTask, Suite } from "./suite.js";
import { digestSuite } from "./suite-digest.js";
import type { AgentAdapter, RunResult, Skill } from "./types.js";
import type { Variant } from "./variants.js";
import { createWorkspace, destroyWorkspace } from "./workspace.js";

/** What a trial needs from the options of `runBench`/`resumeRun`. */
type TrialEnv = Pick<
  BenchOptions,
  "adapter" | "store" | "outDir" | "model" | "onTrial" | "signal" | "concurrency"
>;

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
  /**
   * Trials in flight at once: a positive integer, default 1 (sequential). Trials start in the
   * order task, repeat, variant, so variants stay interleaved within each repeat; with more than
   * one in flight, they finish (and are stored and reported) in completion order. The adapter
   * must tolerate that many simultaneous runs (each trial gets its own workspace).
   */
  concurrency?: number;
  onTrial?: (trial: TrialRecord) => void;
  /**
   * Checked before the run is created and before each trial starts; running trials are not
   * interrupted but finish and are stored. On abort `runBench` rejects with `signal.reason` (an
   * `AbortError` for a plain `abort()`) once they have drained; `resumeBench` can finish the run.
   */
  signal?: AbortSignal;
}

/**
 * True when the harness, not the skill, failed: the adapter errored (unless it says the agent
 * itself failed), or the judge could not deliver a verdict (a scored verdict, even a low one, is
 * a measurement). Timeouts are skill failures: a skill that makes the agent loop should lose.
 */
function isInfraError(result: RunResult, assertions: AssertionResult[]): boolean {
  if (result.status === "error") return result.errorKind !== "agent";
  return assertions.some((a) => a.type === "judge" && !a.passed && a.score === undefined);
}

const fileStem = (variant: string, taskId: string, repeatIdx: number) =>
  `${variant.replace(/[^\w.@+-]/g, "_")}__${taskId}__${repeatIdx}`;

async function runTrial(
  o: TrialEnv,
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
      if (task.judge) {
        // Always judged, even when assertions failed, so scores are comparable across variants.
        assertions.push(
          await runJudge({
            adapter: o.adapter,
            spec: task.judge,
            taskPrompt: task.prompt,
            finalMessage: result.finalMessage,
            ws,
          }),
        );
      }
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
    infraError: isInfraError(result, assertions),
    transcriptPath: `${runRel}/${stem}.jsonl`,
    assertions,
  };
}

/** One (task, repeat, variant) cell, in the submission order of a run. */
interface TrialJob {
  task: ResolvedTask;
  variant: Variant;
  repeatIdx: number;
}

/**
 * Every cell of a run in submission order: task by task, repeat by repeat, and the variants in
 * the given order within each repeat, so drift (rate limits, load) hits all of them equally.
 */
function planTrials(suite: Suite, variants: Variant[], repeat: number): TrialJob[] {
  const jobs: TrialJob[] = [];
  for (const task of suite.tasks) {
    for (let repeatIdx = 1; repeatIdx <= repeat; repeatIdx++) {
      for (const variant of variants) jobs.push({ task, variant, repeatIdx });
    }
  }
  return jobs;
}

function checkConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
}

/**
 * Runs `jobs` with at most `concurrency` trials in flight, started in submission order. Each
 * trial is stored (a synchronous transaction, so workers never interleave inside it) and
 * reported as soon as it finishes. After an abort or a failure no new trial starts; trials
 * already running finish and are stored, then the first error (or `signal.reason`) is thrown.
 */
async function executeTrials(
  o: TrialEnv,
  runId: number,
  jobs: TrialJob[],
  concurrency: number,
): Promise<void> {
  const runRel = `runs/${runId}`;
  const runDir = join(o.outDir, runRel);
  await mkdir(runDir, { recursive: true });

  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure) {
      const job = jobs[next];
      if (!job) return;
      if (o.signal?.aborted) {
        failure = { error: o.signal.reason };
        return;
      }
      next++;
      try {
        const trial = await runTrial(o, job.task, job.variant, job.repeatIdx, runDir, runRel);
        o.store.addTrial(runId, trial);
        o.onTrial?.(trial);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (failure) throw failure.error;
}

/**
 * Runs every (task, repeat, variant) trial and returns the run id. Variants are interleaved
 * within each repeat so drift (rate limits, load) hits all of them equally. Trials start in that
 * order, at most `concurrency` (default 1, sequential) at a time.
 */
export async function runBench(o: BenchOptions): Promise<number> {
  o.signal?.throwIfAborted();
  const concurrency = o.concurrency ?? 1;
  checkConcurrency(concurrency);
  const labels = o.variants.map((v) => v.label);
  if (labels.length < 2) throw new Error("A benchmark needs at least two variants to compare");
  if (new Set(labels).size !== labels.length) {
    throw new Error(`Variant labels must be unique, got: ${labels.join(", ")}`);
  }

  const detected = await o.adapter.detect();
  if (!detected.available)
    throw new Error(`Agent "${o.adapter.id}" is not available on this machine`);

  const repeat = o.repeat ?? o.suite.repeat;
  const suiteDigest = await digestSuite(o.suite);
  const runId = o.store.createRun({
    suite: o.suite.name,
    agent: o.adapter.id,
    agentVersion: detected.version,
    model: o.model,
    suiteDigest,
    taskIds: o.suite.tasks.map((t) => t.id),
    repeat,
    variants: o.variants.map((v) => ({
      label: v.label,
      skillName: v.skill?.name,
      skillVersion: v.skill?.version,
      skillDigest: v.skill?.digest,
    })),
  });
  await executeTrials(o, runId, planTrials(o.suite, o.variants, repeat), concurrency);
  return runId;
}

/** Why a stored run cannot be resumed with what was supplied. */
export class ResumeMismatch extends Error {
  override name = "ResumeMismatch";
  constructor(
    /** Which input differs from the run: the suite, a skill, or the agent. */
    readonly kind: "suite" | "skill" | "agent",
    message: string,
  ) {
    super(message);
  }
}

export interface ResumeRunOptions {
  runId: number;
  suite: Suite;
  /** Must contain every skill version the run used (matched by digest); extras are ignored. */
  skills: Skill[];
  adapter: AgentAdapter;
  store: ResultStore;
  outDir: string;
  concurrency?: number;
  onTrial?: (trial: TrialRecord) => void;
  signal?: AbortSignal;
}

const trialKey = (variant: string, taskId: string, repeatIdx: number) =>
  `${variant}\0${taskId}\0${repeatIdx}`;

/**
 * Runs only the (variant, task, repeat) cells that `runId` does not have a trial for, appending
 * them to that run, and returns `runId`. The stored suite digest, skill digests and agent id must
 * match the supplied ones (`ResumeMismatch` otherwise, before anything runs); repeat count and
 * model come from the run. A run with nothing missing is returned untouched without calling the
 * adapter. Stored trials are never re-run, including infrastructure errors.
 */
export async function resumeRun(o: ResumeRunOptions): Promise<number> {
  o.signal?.throwIfAborted();
  const concurrency = o.concurrency ?? 1;
  checkConcurrency(concurrency);

  const run = o.store.getRun(o.runId);
  if (!run) throw new Error(`No run with id ${o.runId}`);
  const { suiteDigest, repeat } = run;
  if (suiteDigest === undefined || repeat === undefined) {
    throw new Error(
      `Run ${run.id} was recorded before suite digests were stored, so it cannot be resumed`,
    );
  }
  const actualDigest = await digestSuite(o.suite);
  if (actualDigest !== suiteDigest) {
    throw new ResumeMismatch(
      "suite",
      `Run ${run.id} used suite ${suiteDigest}, but the supplied suite is ${actualDigest}`,
    );
  }
  if (o.adapter.id !== run.agent) {
    throw new ResumeMismatch(
      "agent",
      `Run ${run.id} used agent "${run.agent}", but the supplied adapter is "${o.adapter.id}"`,
    );
  }
  const variants = run.variants.map((v): Variant => {
    if (v.skillDigest === undefined) {
      if (v.skillName !== undefined) {
        throw new Error(`Run ${run.id} has no digest recorded for variant "${v.label}"`);
      }
      return { label: v.label };
    }
    const skill = o.skills.find((s) => s.digest === v.skillDigest);
    if (!skill) {
      throw new ResumeMismatch(
        "skill",
        `Run ${run.id} variant "${v.label}" used skill ${v.skillName ?? "?"} ${v.skillDigest}, which was not supplied (or has changed since)`,
      );
    }
    return { label: v.label, skill };
  });

  const done = new Set(
    o.store.listTrials(run.id).map((t) => trialKey(t.variant, t.taskId, t.repeatIdx)),
  );
  const pending = planTrials(o.suite, variants, repeat).filter(
    (j) => !done.has(trialKey(j.variant.label, j.task.id, j.repeatIdx)),
  );
  if (pending.length === 0) return run.id;

  const detected = await o.adapter.detect();
  if (!detected.available)
    throw new Error(`Agent "${o.adapter.id}" is not available on this machine`);
  await executeTrials({ ...o, model: run.model }, run.id, pending, concurrency);
  return run.id;
}
