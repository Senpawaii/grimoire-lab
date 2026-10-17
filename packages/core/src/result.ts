/**
 * The benchmark result: a plain, JSON-serializable value that is self-describing (agent, skill
 * digest, suite digest), so it can be stored, shipped between machines, and compared later.
 *
 * ## Stability promise
 *
 * `schemaVersion` is a literal in every serialized result (currently {@link SCHEMA_VERSION}).
 *
 * - Adding an OPTIONAL field does not bump it. Consumers must ignore fields they do not know;
 *   `parseBenchResult` strips them.
 * - Renaming or removing a field, making an optional field required, or changing the meaning of a
 *   field (for example what `passRate` is computed over) bumps it.
 * - `parseBenchResult` accepts only versions listed in {@link KNOWN_SCHEMA_VERSIONS} and throws
 *   for anything else, so a consumer never silently reads data it does not understand. Old
 *   versions may be upgraded in `parseBenchResult` instead of being dropped.
 * - The SQLite schema of `ResultStore` is internal and versioned independently.
 *
 * A checked-in golden JSON fixture (`src/fixtures/bench-result.v1.json`, asserted in
 * `result.test.ts`) pins version 1.
 */
import { z } from "zod";
import { type CompareOptions, compare, IncomparableArms } from "./compare.js";
import { mean } from "./report.js";
import type { RunRecord, TrialRecord } from "./store.js";

export const SCHEMA_VERSION = 1;

/** Versions `parseBenchResult` accepts. */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = [SCHEMA_VERSION];

const count = z.number().int().nonnegative();

/**
 * Identity of a skill: the digest is the identity, name/version/source are labels. Structurally
 * identical to `SkillRef` in `sources.ts`; defined here so the result schema is self-contained.
 */
export const SkillRefSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  digest: z.string(),
  source: z.string().optional(),
});

export const AgentSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  model: z.string().optional(),
});

/**
 * Aggregate over a set of trials. `passRate` is passes / ALL trials: errors and timeouts count as
 * failures. `errors` counts trials with `infraError`, so `passes / (trials - errors)` is the
 * pass rate with infrastructure errors excluded. A high `errors / trials` means "inconclusive".
 */
export const ScoreSchema = z.object({
  trials: count,
  passes: count,
  passRate: z.number().min(0).max(1),
  errors: count,
  /** Mean 1-5 judge score over trials that were judged. */
  meanJudgeScore: z.number().optional(),
  meanTokens: z.number().optional(),
  meanDurationMs: z.number(),
  meanCostUsd: z.number().optional(),
});

export const AssertionResultSchema = z.object({
  /** An assertion type, or "judge". A string so new assertion types are additive. */
  type: z.string(),
  passed: z.boolean(),
  detail: z.string(),
  /** 1-5, only for the judge. */
  score: z.number().optional(),
});

export const TrialResultSchema = z.object({
  taskId: z.string(),
  repeatIdx: z.number().int().positive(),
  status: z.enum(["completed", "timeout", "error"]),
  passed: z.boolean(),
  tokens: z.number().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number(),
  finalMessage: z.string(),
  error: z.string().optional(),
  /**
   * The harness could not measure the skill: adapter crash (`status: "error"` unless the adapter
   * says the agent itself failed), rate limit, or a failed judge call. A timeout is a skill
   * failure, not an infra error.
   */
  infraError: z.boolean(),
  /** Relative to the output directory the run was written to. */
  transcriptPath: z.string(),
  assertions: z.array(AssertionResultSchema),
});

export const TaskResultSchema = z.object({
  taskId: z.string(),
  score: ScoreSchema,
  trials: z.array(TrialResultSchema),
});

export const ArmResultSchema = z.object({
  /** Unique within the result. */
  label: z.string(),
  agent: AgentSchema,
  /** Absent = baseline (no skill). */
  skill: SkillRefSchema.optional(),
  score: ScoreSchema,
  tasks: z.array(TaskResultSchema),
});

/** The decision rule used for `verdict` and `significant`; see `compare` in compare.ts. */
export const GateSchema = z.object({
  minTrials: z.number().int().positive(),
  tolerance: z.number().min(0).max(1),
  excludeInfraErrors: z.boolean(),
  /** The pass-rate delta the gate looked at; absent when a side had no countable trials. */
  delta: z.number().optional(),
});

export const ComparisonSchema = z.object({
  kind: z.enum(["skill-vs-baseline", "version-vs-version", "agent-vs-agent"]),
  /** Arm label of the thing being evaluated (skill, newer version, agent A). */
  subject: z.string(),
  /** Arm label of what it is compared against (baseline, older version, agent B). */
  reference: z.string(),
  /** subject minus reference. `passRate` is over all trials, see {@link ScoreSchema}. */
  deltas: z.object({
    passRate: z.number(),
    meanJudgeScore: z.number().optional(),
    meanTokens: z.number().optional(),
    meanDurationMs: z.number(),
    meanCostUsd: z.number().optional(),
  }),
  tasks: z.array(z.object({ taskId: z.string(), passRateDelta: z.number() })),
  /** Trials and infra errors per side, so consumers can demand a minimum sample. */
  n: z.object({
    subject: count,
    reference: count,
    subjectErrors: count,
    referenceErrors: count,
  }),
  comparable: z.literal(true),
  /** Threshold gate, NOT a statistical test. Set by `gate`; see `compare`. */
  significant: z.boolean(),
  verdict: z.enum(["better", "same", "worse"]),
  gate: GateSchema,
});

export const BenchResultSchema = z.object({
  schemaVersion: z.literal(1),
  /** The store id as a string; a stable key for consumers. */
  id: z.string(),
  /** ISO 8601. */
  startedAt: z.string(),
  /** Identity of the tasks and grading (see `digestSuite`), so only like-for-like is compared. */
  suite: z.object({ name: z.string(), digest: z.string(), taskIds: z.array(z.string()) }),
  repeat: z.number().int().positive(),
  /** Run order. */
  arms: z.array(ArmResultSchema),
  /** Computed within this run with the default gate. */
  comparisons: z.array(ComparisonSchema),
});

export type SkillRefShape = z.infer<typeof SkillRefSchema>;
export type AgentInfo = z.infer<typeof AgentSchema>;
export type Score = z.infer<typeof ScoreSchema>;
export type AssertionOutcome = z.infer<typeof AssertionResultSchema>;
export type TrialResult = z.infer<typeof TrialResultSchema>;
export type TaskResult = z.infer<typeof TaskResultSchema>;
export type ArmResult = z.infer<typeof ArmResultSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type Comparison = z.infer<typeof ComparisonSchema>;
export type BenchResult = z.infer<typeof BenchResultSchema>;

/**
 * Validates a serialized result (a JSON string or an already-parsed value). Throws for an unknown
 * `schemaVersion` or a malformed result; unknown extra fields are dropped.
 */
export function parseBenchResult(json: unknown): BenchResult {
  const value: unknown = typeof json === "string" ? JSON.parse(json) : json;
  const version =
    value !== null && typeof value === "object" && "schemaVersion" in value
      ? value.schemaVersion
      : undefined;
  if (typeof version !== "number" || !KNOWN_SCHEMA_VERSIONS.includes(version)) {
    throw new Error(
      `Unsupported BenchResult schemaVersion ${JSON.stringify(version)}; this version of grimoire reads ${KNOWN_SCHEMA_VERSIONS.join(", ")}`,
    );
  }
  const parsed = BenchResultSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "result"}: ${i.message}`);
    throw new Error(`Invalid BenchResult:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/** Spreadable `{key: value}` that is `{}` when the value is undefined (keeps JSON round trips exact). */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const defined = (v: number | undefined): v is number => v !== undefined;

/** Aggregates trials into a `Score`. */
export function scoreTrials(trials: TrialResult[]): Score {
  const passes = trials.filter((t) => t.passed).length;
  return {
    trials: trials.length,
    passes,
    passRate: trials.length === 0 ? 0 : passes / trials.length,
    errors: trials.filter((t) => t.infraError).length,
    ...opt(
      "meanJudgeScore",
      mean(trials.flatMap((t) => t.assertions.map((a) => a.score).filter(defined))),
    ),
    ...opt("meanTokens", mean(trials.map((t) => t.tokens).filter(defined))),
    meanDurationMs: mean(trials.map((t) => t.durationMs)) ?? 0,
    ...opt("meanCostUsd", mean(trials.map((t) => t.costUsd).filter(defined))),
  };
}

function toTrialResult(t: TrialRecord): TrialResult {
  return {
    taskId: t.taskId,
    repeatIdx: t.repeatIdx,
    status: t.status,
    passed: t.passed,
    ...opt("tokens", t.tokens),
    ...opt("costUsd", t.costUsd),
    durationMs: t.durationMs,
    finalMessage: t.finalMessage,
    ...opt("error", t.error),
    // Rows from before schema v4 did not record it; an adapter error was the only source then.
    infraError: t.infraError ?? t.status === "error",
    transcriptPath: t.transcriptPath,
    assertions: t.assertions.map((a) => ({
      type: a.type,
      passed: a.passed,
      detail: a.detail,
      ...opt("score", a.score),
    })),
  };
}

export interface BuildResultContext {
  /** The store does not keep these for old runs; `digestSuite(suite)` and the suite's task ids. */
  suite: { digest: string; taskIds: string[] };
  /** Gate used for the precomputed `comparisons`. Defaults to `DEFAULT_GATE`. */
  gate?: CompareOptions;
}

/**
 * Maps a stored run and its trials to a `BenchResult`. Arms follow the run's variant order and
 * tasks follow `ctx.suite.taskIds`. Within the run, every pair of arms that `deriveKind` accepts
 * is compared: the baseline is always the reference, and between two skill versions the later
 * arm (the newer one, by run order) is the subject.
 */
export function buildBenchResult(
  run: RunRecord,
  trials: TrialRecord[],
  ctx: BuildResultContext,
): BenchResult {
  const agent: AgentInfo = {
    id: run.agent,
    ...opt("version", run.agentVersion),
    ...opt("model", run.model),
  };
  const taskOrder = [...new Set([...ctx.suite.taskIds, ...trials.map((t) => t.taskId)])];

  const arms: ArmResult[] = run.variants.map((v) => {
    if (v.skillName !== undefined && v.skillDigest === undefined) {
      throw new Error(`Variant "${v.label}" has a skill name but no digest`);
    }
    const mine = trials.filter((t) => t.variant === v.label);
    const tasks: TaskResult[] = taskOrder.flatMap((taskId) => {
      const ts = mine
        .filter((t) => t.taskId === taskId)
        .sort((a, b) => a.repeatIdx - b.repeatIdx)
        .map(toTrialResult);
      return ts.length === 0 ? [] : [{ taskId, score: scoreTrials(ts), trials: ts }];
    });
    return {
      label: v.label,
      agent,
      ...(v.skillName !== undefined && v.skillDigest !== undefined
        ? {
            skill: {
              name: v.skillName,
              ...opt("version", v.skillVersion),
              digest: v.skillDigest,
            },
          }
        : {}),
      score: scoreTrials(tasks.flatMap((t) => t.trials)),
      tasks,
    };
  });

  const comparisons: Comparison[] = [];
  const ref = (arm: ArmResult) => ({ suiteDigest: ctx.suite.digest, arm });
  arms.forEach((a, i) => {
    for (const b of arms.slice(i + 1)) {
      // Baseline is the reference; between versions the later arm is the subject.
      const [subject, reference] = b.skill === undefined ? [a, b] : [b, a];
      try {
        comparisons.push(compare(ref(subject), ref(reference), ctx.gate));
      } catch (err) {
        if (!(err instanceof IncomparableArms)) throw err;
      }
    }
  });

  const repeat = run.repeat ?? Math.max(1, ...trials.map((t) => t.repeatIdx));
  return {
    schemaVersion: SCHEMA_VERSION,
    id: String(run.id),
    startedAt: run.startedAt,
    suite: { name: run.suite, digest: ctx.suite.digest, taskIds: ctx.suite.taskIds },
    repeat,
    arms,
    comparisons,
  };
}
