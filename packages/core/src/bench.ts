import { armRef, compare } from "./compare.js";
import { runBench } from "./engine.js";
import { type BenchResult, type Comparison, type TrialResult, toTrialResult } from "./result.js";
import type { SkillRef } from "./sources.js";
import { ResultStore } from "./store.js";
import type { Suite } from "./suite.js";
import type { AgentAdapter, Skill } from "./types.js";
import { buildVariants, type Variant } from "./variants.js";

export interface BenchSkillOptions {
  /** Already loaded (see `loadSkillByDigest`). */
  skill: Skill;
  suite: Suite;
  /** Injected: core never imports an adapter. */
  adapter: AgentAdapter;
  /** Version-vs-version: runs `against` (older) and `skill` (newer). */
  against?: Skill;
  /** Adds a no-skill arm. Default: true unless `against` is set. */
  baseline?: boolean;
  /** Overrides the suite's repeat count. */
  repeat?: number;
  model?: string;
  /** Transcripts and raw logs are written under `<outDir>/runs/<id>/`. */
  outDir: string;
  /**
   * Persists the run (trials are stored as they finish, so an aborted run leaves them behind).
   * Without it a private in-memory store is used and the result is only the return value. The
   * caller owns, and closes, a store it passes in.
   */
  store?: ResultStore;
  /** The only progress hook: called after every trial with the label of the arm it ran on. */
  onTrial?: (trial: TrialResult, arm: string) => void;
  /**
   * The only cancellation mechanism. Checked between trials; the returned promise rejects with
   * `signal.reason` (an `AbortError` for a plain `abort()`).
   */
  signal?: AbortSignal;
}

/**
 * Benchmarks `skill`: against no skill by default, against another version with `against`, or
 * both with `baseline: true`. Returns the self-contained `BenchResult`, comparisons included.
 *
 * Arms run in this order: baseline (if any), `against` (if any), `skill`. Throws before running
 * anything when there is nothing to compare with, or when `against` has the same digest as
 * `skill`.
 */
export async function benchSkill(o: BenchSkillOptions): Promise<BenchResult> {
  const { against } = o;
  const baseline = o.baseline ?? against === undefined;
  if (against === undefined && !baseline) {
    throw new Error("Nothing to compare with: pass `against` or leave `baseline` on");
  }
  // Without `against`, buildVariants already yields [baseline, with-skill].
  const variants: Variant[] = buildVariants(o.skill, against);
  if (against !== undefined && baseline) variants.unshift({ label: "baseline" });

  const store = o.store ?? new ResultStore(":memory:");
  try {
    const { onTrial } = o;
    const id = await runBench({
      suite: o.suite,
      variants,
      adapter: o.adapter,
      store,
      outDir: o.outDir,
      repeat: o.repeat,
      model: o.model,
      signal: o.signal,
      onTrial: onTrial && ((t) => onTrial(toTrialResult(t), t.variant)),
    });
    const result = store.getResult(id);
    if (!result) throw new Error(`Run ${id} vanished from the store`);
    return result;
  } finally {
    if (!o.store) store.close();
  }
}

export interface BenchProposalOptions extends Omit<BenchSkillOptions, "skill" | "against"> {
  current: Skill;
  /** `loadSkill(dir)` of the staged and edited candidate (see `stageCandidate`). */
  candidate: Skill;
  /** Adds a no-skill arm (three arms, three comparisons). Default false. */
  baseline?: boolean;
}

/** The outcome of benchmarking a candidate version against the current one. */
export interface BenchProposal {
  current: SkillRef;
  candidate: SkillRef;
  result: BenchResult;
  /** kind `version-vs-version`: subject = candidate, reference = current. */
  comparison: Comparison;
}

const refOf = (s: Skill): SkillRef => ({
  name: s.name,
  ...(s.version === undefined ? {} : { version: s.version }),
  digest: s.digest,
});

/**
 * `benchSkill` with `against: current`, plus a typed return. Run on `suite`, which should be the
 * current skill's suite so both versions face the same tasks. Throws when both have the same
 * digest. Promotion is the caller's decision: read `comparison` and apply your own policy.
 */
export async function benchProposal(o: BenchProposalOptions): Promise<BenchProposal> {
  const { current, candidate, baseline = false, ...rest } = o;
  const result = await benchSkill({ ...rest, skill: candidate, against: current, baseline });
  return {
    current: refOf(current),
    candidate: refOf(candidate),
    result,
    comparison: compare(armRef(result, candidate), armRef(result, current)),
  };
}
