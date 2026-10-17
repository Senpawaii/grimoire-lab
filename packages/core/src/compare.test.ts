import { describe, expect, it } from "vitest";
import {
  type ArmRef,
  armRef,
  compare,
  deriveKind,
  evidenceFor,
  IncomparableArms,
  SuiteMismatch,
} from "./compare.js";
import { type ArmResult, type BenchResult, scoreTrials, type TrialResult } from "./result.js";

const SUITE = "sha256:suite";

/** [passed, failed, infra errors] for one task. */
type Counts = [number, number, number];

function taskTrials(taskId: string, [passed, failed, infra]: Counts): TrialResult[] {
  const make = (i: number, over: Partial<TrialResult>): TrialResult => ({
    taskId,
    repeatIdx: i + 1,
    status: "completed",
    passed: false,
    durationMs: 1000,
    finalMessage: "",
    infraError: false,
    transcriptPath: "p",
    assertions: [],
    ...over,
  });
  return [
    ...Array.from({ length: passed }, (_, i) => make(i, { passed: true })),
    ...Array.from({ length: failed }, (_, i) => make(passed + i, {})),
    ...Array.from({ length: infra }, (_, i) =>
      make(passed + failed + i, { status: "error", infraError: true }),
    ),
  ];
}

const SKILL = { name: "demo", version: "1.0.0", digest: "sha256:v1" };
const AGENT = { id: "claude-code", version: "2.1.0", model: "haiku" };

function arm(
  label: string,
  counts: Record<string, Counts>,
  over: Partial<ArmResult> = {},
): ArmResult {
  const tasks = Object.entries(counts).map(([taskId, c]) => {
    const trials = taskTrials(taskId, c);
    return { taskId, score: scoreTrials(trials), trials };
  });
  return {
    label,
    agent: AGENT,
    score: scoreTrials(tasks.flatMap((t) => t.trials)),
    tasks,
    ...over,
  };
}

const ref = (a: ArmResult, suiteDigest = SUITE): ArmRef => ({ suiteDigest, arm: a });
const skillArm = (counts: Record<string, Counts>, over: Partial<ArmResult> = {}) =>
  arm("with-skill", counts, { skill: SKILL, ...over });
const baseline = (counts: Record<string, Counts>) => arm("baseline", counts);

describe("compare: verdict", () => {
  it("better: a large delta with enough trials", () => {
    const c = compare(
      ref(skillArm({ a: [4, 1, 0], b: [4, 1, 0] })),
      ref(baseline({ a: [1, 4, 0], b: [2, 3, 0] })),
    );
    expect(c).toMatchObject({
      kind: "skill-vs-baseline",
      subject: "with-skill",
      reference: "baseline",
      significant: true,
      verdict: "better",
      comparable: true,
      n: { subject: 10, reference: 10, subjectErrors: 0, referenceErrors: 0 },
    });
    expect(c.deltas.passRate).toBeCloseTo(0.5);
    expect(c.tasks.map((t) => [t.taskId, +t.passRateDelta.toFixed(2)])).toEqual([
      ["a", 0.6],
      ["b", 0.4],
    ]);
  });

  it("worse: a large drop with enough trials", () => {
    const c = compare(ref(skillArm({ a: [1, 9, 0] })), ref(baseline({ a: [8, 2, 0] })));
    expect(c).toMatchObject({ significant: true, verdict: "worse" });
    expect(c.deltas.passRate).toBeCloseTo(-0.7);
  });

  it("same: equal pass rates", () => {
    const c = compare(ref(skillArm({ a: [5, 5, 0] })), ref(baseline({ a: [5, 5, 0] })));
    expect(c).toMatchObject({ significant: false, verdict: "same", deltas: { passRate: 0 } });
  });

  it("same: a delta below the tolerance, even with plenty of trials", () => {
    const c = compare(ref(skillArm({ a: [53, 47, 0] })), ref(baseline({ a: [50, 50, 0] })));
    expect(c.verdict).toBe("same");
    expect(c.deltas.passRate).toBeCloseTo(0.03);
  });

  it("treats a delta exactly at the tolerance as significant despite float error", () => {
    const sub = ref(skillArm({ a: [6, 4, 0] }));
    const base = ref(baseline({ a: [5, 5, 0] }));
    expect(compare(sub, base).verdict).toBe("better"); // 0.6 - 0.5 = 0.0999..98
    expect(compare(sub, base, { tolerance: 0.2 }).verdict).toBe("same");
  });

  it("same: too few trials on either side, whatever the delta", () => {
    const small = ref(skillArm({ a: [2, 0, 0] }));
    const base = ref(baseline({ a: [0, 2, 0] }));
    const c = compare(small, base);
    expect(c).toMatchObject({ significant: false, verdict: "same" });
    expect(c.gate).toEqual({ minTrials: 5, tolerance: 0.1, excludeInfraErrors: true, delta: 1 });
    expect(compare(small, base, { minTrials: 2 })).toMatchObject({
      significant: true,
      verdict: "better",
    });
    // one thin side is enough to withhold the verdict
    const big = ref(baseline({ a: [0, 10, 0] }));
    expect(compare(small, big)).toMatchObject({ significant: false, verdict: "same" });
  });

  it("minTrials counts trials pooled over all tasks, not per task", () => {
    const sub = ref(skillArm({ a: [3, 0, 0], b: [3, 0, 0] }));
    const base = ref(baseline({ a: [0, 3, 0], b: [0, 3, 0] }));
    expect(compare(sub, base).verdict).toBe("better");
  });

  it("excludes infra errors from the gate by default, but not from deltas or n", () => {
    // 5 passes + 5 infra errors: 0.5 over all trials, 1.0 over countable ones.
    const sub = ref(skillArm({ a: [5, 0, 5] }));
    const base = ref(baseline({ a: [5, 5, 0] }));
    const excluded = compare(sub, base);
    expect(excluded).toMatchObject({
      significant: true,
      verdict: "better",
      deltas: { passRate: 0 },
      n: { subject: 10, subjectErrors: 5, reference: 10, referenceErrors: 0 },
      gate: { excludeInfraErrors: true, delta: 0.5 },
    });
    const included = compare(sub, base, { excludeInfraErrors: false });
    expect(included).toMatchObject({ significant: false, verdict: "same" });
    expect(included.gate).toMatchObject({ excludeInfraErrors: false, delta: 0 });
  });

  it("does not reach a verdict when infra errors leave too few countable trials", () => {
    const sub = ref(skillArm({ a: [4, 0, 6] }));
    const base = ref(baseline({ a: [0, 10, 0] }));
    expect(compare(sub, base)).toMatchObject({ significant: false, verdict: "same" });
    expect(compare(sub, base, { excludeInfraErrors: false })).toMatchObject({
      significant: true,
      verdict: "better",
    });
  });

  it("is same, with no gate delta, when a side has no countable trials", () => {
    const c = compare(ref(skillArm({ a: [0, 0, 6] })), ref(baseline({ a: [5, 5, 0] })));
    expect(c).toMatchObject({ significant: false, verdict: "same" });
    expect(c.gate).not.toHaveProperty("delta");
  });

  it("validates the gate options", () => {
    const s = ref(skillArm({ a: [1, 0, 0] }));
    const b = ref(baseline({ a: [0, 1, 0] }));
    expect(() => compare(s, b, { minTrials: 0 })).toThrow(RangeError);
    expect(() => compare(s, b, { minTrials: 1.5 })).toThrow(RangeError);
    expect(() => compare(s, b, { tolerance: -0.1 })).toThrow(RangeError);
    expect(() => compare(s, b, { tolerance: 2 })).toThrow(RangeError);
  });
});

describe("compare: deltas and inputs", () => {
  it("subtracts reference from subject for every metric, omitting absent ones", () => {
    const withMetrics = (a: ArmResult, m: Partial<ArmResult["score"]>): ArmResult => ({
      ...a,
      score: { ...a.score, ...m },
    });
    const c = compare(
      ref(
        withMetrics(skillArm({ a: [5, 0, 0] }), {
          meanTokens: 100,
          meanDurationMs: 800,
          meanJudgeScore: 4,
          meanCostUsd: 0.5,
        }),
      ),
      ref(withMetrics(baseline({ a: [5, 0, 0] }), { meanTokens: 150, meanDurationMs: 1000 })),
    );
    expect(c.deltas).toEqual({
      passRate: 0,
      meanTokens: -50,
      meanDurationMs: -200,
    });
  });

  it("throws SuiteMismatch when the suite digests differ", () => {
    const s = ref(skillArm({ a: [5, 0, 0] }), "sha256:one");
    const b = ref(baseline({ a: [5, 0, 0] }), "sha256:two");
    expect(() => compare(s, b)).toThrow(SuiteMismatch);
    expect(() => compare(s, b)).toThrow(/different suites/);
  });

  it("throws when the arms ran different task ids", () => {
    expect(() => compare(ref(skillArm({ a: [5, 0, 0] })), ref(baseline({ b: [5, 0, 0] })))).toThrow(
      IncomparableArms,
    );
    expect(() =>
      compare(ref(skillArm({ a: [5, 0, 0], b: [1, 0, 0] })), ref(baseline({ a: [5, 0, 0] }))),
    ).toThrow(/different task ids/);
  });

  it("ignores repeat counts: different trial totals per task still compare", () => {
    const c = compare(ref(skillArm({ a: [5, 0, 0] })), ref(baseline({ a: [3, 7, 0] })));
    expect(c.n).toMatchObject({ subject: 5, reference: 10 });
  });

  it("compares arms from different results via armRef", () => {
    const result = (id: string, label: string, over: Partial<ArmResult>): BenchResult => ({
      schemaVersion: 1,
      id,
      startedAt: "2026-10-17T00:00:00.000Z",
      suite: { name: "s", digest: SUITE, taskIds: ["a"] },
      repeat: 5,
      arms: [arm(label, { a: [5, 0, 0] }, over)],
      comparisons: [],
    });
    const oldRun = result("1", "demo@1.0.0", { skill: SKILL });
    const newRun = result("2", "demo@1.1.0", {
      skill: { ...SKILL, version: "1.1.0", digest: "sha256:v2" },
    });
    const c = compare(armRef(newRun, "demo@1.1.0"), armRef(oldRun, SKILL));
    expect(c).toMatchObject({
      kind: "version-vs-version",
      subject: "demo@1.1.0",
      reference: "demo@1.0.0",
    });
    expect(() => armRef(oldRun, "nope")).toThrow(/no arm with label "nope"/);
    expect(() => armRef(oldRun, { digest: "sha256:zzz" })).toThrow(/no arm with skill/);
  });
});

describe("deriveKind", () => {
  const counts = { a: [5, 0, 0] as Counts };
  const v2 = { ...SKILL, version: "1.1.0", digest: "sha256:v2" };

  it("classifies skill-vs-baseline, version-vs-version and agent-vs-agent", () => {
    expect(deriveKind(skillArm(counts), baseline(counts))).toBe("skill-vs-baseline");
    expect(deriveKind(skillArm(counts, { skill: v2 }), skillArm(counts))).toBe(
      "version-vs-version",
    );
    const other = { agent: { ...AGENT, model: "opus" } };
    expect(deriveKind(skillArm(counts, other), skillArm(counts))).toBe("agent-vs-agent");
    expect(deriveKind(arm("x", counts, other), baseline(counts))).toBe("agent-vs-agent");
    const newer = { agent: { ...AGENT, version: "2.2.0" } };
    expect(deriveKind(skillArm(counts, newer), skillArm(counts))).toBe("agent-vs-agent");
  });

  it("throws for anything else", () => {
    const other = { agent: { ...AGENT, model: "opus" } };
    expect(() => deriveKind(baseline(counts), baseline(counts))).toThrow(IncomparableArms);
    expect(() => deriveKind(skillArm(counts), skillArm(counts))).toThrow(/identical skill/);
    expect(() => deriveKind(baseline(counts), skillArm(counts))).toThrow(/subject is the baseline/);
    expect(() =>
      deriveKind(skillArm(counts, { skill: { ...v2, name: "other" } }), skillArm(counts)),
    ).toThrow(/different skills/);
    expect(() => deriveKind(skillArm(counts, { ...other, skill: v2 }), skillArm(counts))).toThrow(
      /both differ/,
    );
    expect(() => deriveKind(skillArm(counts, other), baseline(counts))).toThrow(/agents differ/);
  });
});

describe("evidenceFor", () => {
  const v2 = { name: "demo", version: "1.1.0", digest: "sha256:v2" };
  const arms = [
    baseline({ a: [2, 8, 0] }),
    arm("demo@1.0.0", { a: [5, 5, 0] }, { skill: SKILL }),
    arm("demo@1.1.0", { a: [9, 1, 0] }, { skill: v2 }),
  ];
  const subject = (label: string) => ref(arms.find((a) => a.label === label) as ArmResult);
  const result: BenchResult = {
    schemaVersion: 1,
    id: "1",
    startedAt: "2026-10-17T00:00:00.000Z",
    suite: { name: "s", digest: SUITE, taskIds: ["a"] },
    repeat: 10,
    arms,
    comparisons: [
      compare(subject("demo@1.0.0"), subject("baseline")),
      compare(subject("demo@1.1.0"), subject("baseline")),
      compare(subject("demo@1.1.0"), subject("demo@1.0.0")),
    ],
  };

  it("returns the skill's arm score, agent and its comparisons, looked up by digest", () => {
    const e = evidenceFor(result, v2);
    expect(e.skill).toEqual(v2);
    expect(e.agent).toEqual(AGENT);
    expect(e.score).toBe(arms[2]?.score);
    expect(e.vsBaseline).toMatchObject({ kind: "skill-vs-baseline", subject: "demo@1.1.0" });
    expect(e.vsPrevious).toMatchObject({
      kind: "version-vs-version",
      subject: "demo@1.1.0",
      reference: "demo@1.0.0",
      verdict: "better",
    });
  });

  it("omits comparisons the arm is not the subject of", () => {
    const e = evidenceFor(result, SKILL);
    expect(e.vsBaseline).toBeDefined();
    expect(e.vsPrevious).toBeUndefined();
    expect(e).not.toHaveProperty("vsPrevious");
  });

  it("throws when the result has no arm with that digest", () => {
    expect(() => evidenceFor(result, { digest: "sha256:unknown" })).toThrow(/no arm with skill/);
  });
});
