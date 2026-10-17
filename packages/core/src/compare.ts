import type { ArmResult, BenchResult, Comparison, Gate, Score } from "./result.js";

/** The two arms cannot be meaningfully compared (see `deriveKind`). */
export class IncomparableArms extends Error {
  override name = "IncomparableArms";
}

/** The two arms ran different suites (different task set, prompts, grading or fixtures). */
export class SuiteMismatch extends IncomparableArms {
  override name = "SuiteMismatch";
}

/**
 * Decision rule for `significant` and `verdict`. It is a THRESHOLD GATE, not a statistical test:
 * there is no p-value or confidence interval. It exists so that a tiny sample or a tiny delta is
 * reported as "same" instead of "better". Consumers MUST set their own `minTrials` and
 * `tolerance` before acting on it (for example before auto-promoting a skill version).
 */
export interface CompareOptions {
  /**
   * Minimum number of countable trials on EACH side, pooled over all tasks of the arm (not per
   * task). Default 5.
   */
  minTrials?: number;
  /** Smallest |pass-rate delta| (0..1) treated as a real change. Default 0.1. */
  tolerance?: number;
  /**
   * Leave trials with `infraError` out of the gate: the pass rate becomes
   * `passes / (trials - errors)` and `minTrials` counts only trials that were not infra errors.
   * Default true. Only the gate is affected; `deltas` and `tasks` always use `Score.passRate`.
   */
  excludeInfraErrors?: boolean;
}

export const DEFAULT_GATE = { minTrials: 5, tolerance: 0.1, excludeInfraErrors: true } as const;

/** An arm together with the digest of the suite it ran, so arms from different runs can be compared. */
export interface ArmRef {
  suiteDigest: string;
  arm: ArmResult;
}

/**
 * Picks an arm out of a result by label, or by skill digest (a `SkillRef` or anything with a
 * `digest`). Throws if no arm matches.
 */
export function armRef(result: BenchResult, which: string | { digest: string }): ArmRef {
  const arm = result.arms.find((a) =>
    typeof which === "string" ? a.label === which : a.skill?.digest === which.digest,
  );
  if (!arm) {
    const what = typeof which === "string" ? `label "${which}"` : `skill ${which.digest}`;
    throw new Error(
      `Result ${result.id} has no arm with ${what} (arms: ${result.arms.map((a) => a.label).join(", ")})`,
    );
  }
  return { suiteDigest: result.suite.digest, arm };
}

const agentKey = (a: ArmResult) => JSON.stringify([a.agent.id, a.agent.version, a.agent.model]);

/**
 * What differs between the two arms, which fixes how to read the comparison:
 *
 * - reference has no skill, subject has one, same agent: `skill-vs-baseline`
 * - same skill name, different digest, same agent: `version-vs-version`
 * - same skill digest (or both baseline), different agent, agent version or model:
 *   `agent-vs-agent`
 *
 * Anything else (identical arms, a baseline subject against a skill reference, different skill
 * names, or a skill change confounded with an agent change) throws `IncomparableArms`.
 */
export function deriveKind(subject: ArmResult, reference: ArmResult): Comparison["kind"] {
  const fail = (why: string): never => {
    throw new IncomparableArms(
      `Cannot compare "${subject.label}" with "${reference.label}": ${why}`,
    );
  };
  const sameAgent = agentKey(subject) === agentKey(reference);
  const s = subject.skill;
  const r = reference.skill;

  if (r === undefined) {
    if (s !== undefined) return sameAgent ? "skill-vs-baseline" : fail("the agents differ");
    return sameAgent ? fail("both are the same baseline") : "agent-vs-agent";
  }
  if (s === undefined) return fail("the subject is the baseline but the reference has a skill");
  if (s.digest === r.digest)
    return sameAgent ? fail("identical skill and agent") : "agent-vs-agent";
  if (s.name !== r.name) return fail(`different skills (${s.name} vs ${r.name})`);
  return sameAgent ? "version-vs-version" : fail("the skill and the agent both differ");
}

/** `{key: a - b}` when both metrics exist, else `{}`, so absent metrics stay absent in JSON. */
function optionalDelta<K extends string>(key: K, a?: number, b?: number): { [P in K]?: number } {
  return a === undefined || b === undefined ? {} : ({ [key]: a - b } as { [P in K]: number });
}

/** Pass rate over countable trials, or undefined if there are none. */
function gateRate(s: Score, excludeInfraErrors: boolean): { rate?: number; countable: number } {
  const countable = excludeInfraErrors ? s.trials - s.errors : s.trials;
  return countable > 0 ? { rate: s.passes / countable, countable } : { countable };
}

const EPS = 1e-9;

/**
 * Compares `subject` (the thing being evaluated: a skill, the newer version, agent A) against
 * `reference` (baseline, older version, agent B). Pure; deltas are subject minus reference.
 *
 * Throws `SuiteMismatch` if the suite digests differ, and `IncomparableArms` if the arms do not
 * run the same task ids or `deriveKind` rejects them. Arms from different runs, machines and
 * agents can be compared as long as the suite digest matches.
 *
 * ## `significant` and `verdict`
 *
 * Let `rate` be each side's pass rate (see `CompareOptions.excludeInfraErrors`) and
 * `delta = rate(subject) - rate(reference)`.
 *
 * - `significant` = both sides have at least `minTrials` countable trials AND
 *   `|delta| >= tolerance` AND `delta != 0`.
 * - `verdict` = `"better"` if significant and `delta > 0`, `"worse"` if significant and
 *   `delta < 0`, otherwise `"same"`.
 *
 * Defaults: `minTrials` 5, `tolerance` 0.1, `excludeInfraErrors` true. The rule used is recorded
 * in `Comparison.gate`. This is a threshold gate, NOT a statistical test (no p-value, no
 * confidence interval): with LLM agents, 5 trials per side and a 0.1 delta is still noise-prone.
 * Set your own `minTrials`/`tolerance`, or compute an interval from `TaskResult.trials`, before
 * acting on the verdict.
 */
export function compare(subject: ArmRef, reference: ArmRef, opts: CompareOptions = {}): Comparison {
  const minTrials = opts.minTrials ?? DEFAULT_GATE.minTrials;
  const tolerance = opts.tolerance ?? DEFAULT_GATE.tolerance;
  const excludeInfraErrors = opts.excludeInfraErrors ?? DEFAULT_GATE.excludeInfraErrors;
  if (!Number.isInteger(minTrials) || minTrials < 1) {
    throw new RangeError(`minTrials must be a positive integer, got ${minTrials}`);
  }
  if (!(tolerance >= 0 && tolerance <= 1)) {
    throw new RangeError(`tolerance must be between 0 and 1, got ${tolerance}`);
  }

  const s = subject.arm;
  const r = reference.arm;
  if (subject.suiteDigest !== reference.suiteDigest) {
    throw new SuiteMismatch(
      `Cannot compare "${s.label}" with "${r.label}": they ran different suites (${subject.suiteDigest} vs ${reference.suiteDigest})`,
    );
  }
  const kind = deriveKind(s, r);

  const refTasks = new Map(r.tasks.map((t) => [t.taskId, t]));
  const sameTasks =
    s.tasks.length === r.tasks.length && s.tasks.every((t) => refTasks.has(t.taskId));
  if (!sameTasks) {
    throw new IncomparableArms(
      `Cannot compare "${s.label}" with "${r.label}": they ran different task ids (${s.tasks.map((t) => t.taskId).join(", ")} vs ${r.tasks.map((t) => t.taskId).join(", ")})`,
    );
  }

  const sg = gateRate(s.score, excludeInfraErrors);
  const rg = gateRate(r.score, excludeInfraErrors);
  const delta = sg.rate !== undefined && rg.rate !== undefined ? sg.rate - rg.rate : undefined;
  const significant =
    delta !== undefined &&
    sg.countable >= minTrials &&
    rg.countable >= minTrials &&
    delta !== 0 &&
    Math.abs(delta) >= tolerance - EPS;
  const gate: Gate = {
    minTrials,
    tolerance,
    excludeInfraErrors,
    ...(delta === undefined ? {} : { delta }),
  };

  return {
    kind,
    subject: s.label,
    reference: r.label,
    deltas: {
      passRate: s.score.passRate - r.score.passRate,
      ...optionalDelta("meanJudgeScore", s.score.meanJudgeScore, r.score.meanJudgeScore),
      ...optionalDelta("meanTokens", s.score.meanTokens, r.score.meanTokens),
      meanDurationMs: s.score.meanDurationMs - r.score.meanDurationMs,
      ...optionalDelta("meanCostUsd", s.score.meanCostUsd, r.score.meanCostUsd),
    },
    tasks: s.tasks.map((t) => ({
      taskId: t.taskId,
      passRateDelta: t.score.passRate - (refTasks.get(t.taskId)?.score.passRate ?? 0),
    })),
    n: {
      subject: s.score.trials,
      reference: r.score.trials,
      subjectErrors: s.score.errors,
      referenceErrors: r.score.errors,
    },
    comparable: true,
    significant,
    verdict: !significant || delta === undefined ? "same" : delta > 0 ? "better" : "worse",
    gate,
  };
}

/** What a consumer needs to derive a rank for one skill; see design section 5. */
export interface SkillEvidence {
  skill: NonNullable<ArmResult["skill"]>;
  /** The skill arm's overall score. */
  score: Score;
  /** skill-vs-baseline, if the run had a baseline arm. */
  vsBaseline?: Comparison;
  /** version-vs-version with this skill as the subject (the newer version), if benchmarked. */
  vsPrevious?: Comparison;
  agent: ArmResult["agent"];
}

/**
 * Looks up the arm running `skill` (matched by digest, the skill's identity) and the comparisons
 * of that arm in `result`. A lookup over existing fields, not a new data source; ranks and
 * thresholds are the consumer's. Throws if no arm ran that digest.
 */
export function evidenceFor(result: BenchResult, skill: { digest: string }): SkillEvidence {
  const arm = armRef(result, skill).arm;
  const armSkill = arm.skill;
  if (!armSkill) throw new Error(`Arm "${arm.label}" has no skill`); // unreachable: matched by digest
  const own = result.comparisons.filter((c) => c.subject === arm.label);
  const vsBaseline = own.find((c) => c.kind === "skill-vs-baseline");
  const vsPrevious = own.find((c) => c.kind === "version-vs-version");
  return {
    skill: armSkill,
    score: arm.score,
    ...(vsBaseline ? { vsBaseline } : {}),
    ...(vsPrevious ? { vsPrevious } : {}),
    agent: arm.agent,
  };
}
