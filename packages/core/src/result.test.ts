import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type BenchResult,
  BenchResultSchema,
  buildBenchResult,
  parseBenchResult,
  scoreTrials,
} from "./result.js";
import { ResultStore, type RunRecord, type TrialRecord } from "./store.js";

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/bench-result.v1.json", import.meta.url), "utf8"),
) as unknown;

const run: RunRecord = {
  id: 7,
  suite: "demo-suite",
  agent: "claude-code",
  agentVersion: "2.1.0",
  model: "haiku",
  startedAt: "2026-10-17T12:00:00.000Z",
  repeat: 2,
  suiteDigest: "sha256:suite",
  taskIds: ["t1"],
  variants: [
    { label: "baseline" },
    { label: "with-skill", skillName: "demo", skillVersion: "1.0.0", skillDigest: "sha256:skill" },
  ],
};

const fileCheck = (passed: boolean) => ({
  type: "file_exists" as const,
  passed,
  detail: passed ? "out.txt" : "missing out.txt",
});

const trials: TrialRecord[] = [
  {
    variant: "baseline",
    taskId: "t1",
    repeatIdx: 1,
    status: "completed",
    passed: true,
    tokens: 100,
    costUsd: 0.25,
    durationMs: 1000,
    finalMessage: "done",
    infraError: false,
    transcriptPath: "runs/7/baseline__t1__1.jsonl",
    assertions: [fileCheck(true)],
  },
  {
    variant: "with-skill",
    taskId: "t1",
    repeatIdx: 2,
    status: "completed",
    passed: true,
    tokens: 120,
    costUsd: 0.375,
    durationMs: 1200,
    finalMessage: "done",
    infraError: false,
    transcriptPath: "runs/7/with-skill__t1__2.jsonl",
    assertions: [fileCheck(true), { type: "judge", passed: true, detail: "judge 5/5", score: 5 }],
  },
  {
    variant: "with-skill",
    taskId: "t1",
    repeatIdx: 1,
    status: "completed",
    passed: true,
    tokens: 80,
    costUsd: 0.125,
    durationMs: 800,
    finalMessage: "done",
    infraError: false,
    transcriptPath: "runs/7/with-skill__t1__1.jsonl",
    assertions: [fileCheck(true), { type: "judge", passed: true, detail: "judge 4/5", score: 4 }],
  },
  {
    variant: "baseline",
    taskId: "t1",
    repeatIdx: 2,
    status: "completed",
    passed: false,
    tokens: 200,
    costUsd: 0.75,
    durationMs: 3000,
    finalMessage: "nope",
    infraError: false,
    transcriptPath: "runs/7/baseline__t1__2.jsonl",
    assertions: [fileCheck(false)],
  },
];

const ctx = { suite: { digest: "sha256:suite", taskIds: ["t1"] } };

describe("buildBenchResult", () => {
  it("maps a stored run to the v1 golden fixture (arms in run order, trials by repeat)", () => {
    expect(buildBenchResult(run, trials, ctx)).toStrictEqual(golden);
  });

  it("survives JSON: build -> stringify -> parseBenchResult deep-equals", () => {
    const built = buildBenchResult(run, trials, ctx);
    expect(parseBenchResult(JSON.stringify(built))).toStrictEqual(built);
    expect(parseBenchResult(JSON.parse(JSON.stringify(built)))).toStrictEqual(built);
  });

  it("falls back to status === error for rows without an infraError flag", () => {
    const { infraError: _, ...rest } = trials[0] as TrialRecord;
    const errored: TrialRecord = { ...rest, status: "error", passed: false, error: "boom" };
    const timedOut: TrialRecord = { ...rest, status: "timeout", passed: false };
    const result = buildBenchResult(run, [errored, timedOut], ctx);
    const baseline = result.arms[0];
    expect(baseline?.tasks[0]?.trials.map((t) => t.infraError)).toEqual([true, false]);
    expect(baseline?.score).toMatchObject({ trials: 2, passes: 0, passRate: 0, errors: 1 });
  });

  it("keeps an explicit infraError: false on an errored trial (the agent failed)", () => {
    const t: TrialRecord = { ...(trials[0] as TrialRecord), status: "error", infraError: false };
    const result = buildBenchResult(run, [t], ctx);
    expect(result.arms[0]?.score.errors).toBe(0);
  });

  it("computes one comparison for baseline/skill and none-kinded pairs are skipped", () => {
    const result = buildBenchResult(run, trials, ctx);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({
      kind: "skill-vs-baseline",
      subject: "with-skill",
      reference: "baseline",
    });
  });

  it("builds three comparisons for baseline plus two versions, newer as the subject", () => {
    const three: RunRecord = {
      ...run,
      variants: [
        { label: "baseline" },
        {
          label: "demo@0.9.0",
          skillName: "demo",
          skillVersion: "0.9.0",
          skillDigest: "sha256:old",
        },
        {
          label: "demo@1.0.0",
          skillName: "demo",
          skillVersion: "1.0.0",
          skillDigest: "sha256:new",
        },
      ],
    };
    const result = buildBenchResult(three, [], ctx);
    expect(result.comparisons.map((c) => [c.kind, c.subject, c.reference])).toEqual([
      ["skill-vs-baseline", "demo@0.9.0", "baseline"],
      ["skill-vs-baseline", "demo@1.0.0", "baseline"],
      ["version-vs-version", "demo@1.0.0", "demo@0.9.0"],
    ]);
  });

  it("derives repeat from the trials when the run did not record it", () => {
    const { repeat: _, ...noRepeat } = run;
    expect(buildBenchResult(noRepeat, trials, ctx).repeat).toBe(2);
  });

  it("refuses a skill variant that has no digest", () => {
    const bad: RunRecord = { ...run, variants: [{ label: "x", skillName: "demo" }] };
    expect(() => buildBenchResult(bad, [], ctx)).toThrow(/no digest/);
  });
});

describe("scoreTrials", () => {
  it("counts every trial in the denominator and averages only reported metrics", () => {
    const built = buildBenchResult(run, trials, ctx);
    const all = built.arms.flatMap((a) => a.tasks.flatMap((t) => t.trials));
    expect(scoreTrials(all)).toMatchObject({ trials: 4, passes: 3, passRate: 0.75, errors: 0 });
    expect(scoreTrials([])).toEqual({
      trials: 0,
      passes: 0,
      passRate: 0,
      errors: 0,
      meanDurationMs: 0,
    });
  });
});

describe("parseBenchResult", () => {
  it("accepts the golden v1 fixture, as a value or as JSON text", () => {
    expect(parseBenchResult(golden)).toStrictEqual(golden);
    expect(parseBenchResult(JSON.stringify(golden))).toStrictEqual(golden);
  });

  it("rejects unknown or missing schema versions instead of guessing", () => {
    expect(() => parseBenchResult({ ...(golden as object), schemaVersion: 2 })).toThrow(
      /Unsupported BenchResult schemaVersion 2/,
    );
    const { schemaVersion: _, ...unversioned } = golden as BenchResult;
    expect(() => parseBenchResult(unversioned)).toThrow(/Unsupported/);
    expect(() => parseBenchResult(null)).toThrow(/Unsupported/);
  });

  it("rejects a malformed result, naming the path", () => {
    const broken = structuredClone(golden) as BenchResult;
    (broken.arms[0] as { score: { passRate: number } }).score.passRate = 2;
    expect(() => parseBenchResult(broken)).toThrow(/arms\.0\.score\.passRate/);
  });

  it("ignores unknown extra fields, so additive optional fields do not break old readers", () => {
    const extended = structuredClone(golden) as Record<string, unknown>;
    extended.futureField = { a: 1 };
    ((extended.arms as Record<string, unknown>[])[0] as Record<string, unknown>).other = true;
    expect(parseBenchResult(extended)).toStrictEqual(golden);
    expect(BenchResultSchema.safeParse(extended).success).toBe(true);
  });
});

describe("ResultStore.getResult / latestResult", () => {
  it("reads a persisted run back as a BenchResult", () => {
    const store = new ResultStore(":memory:");
    const id = store.createRun({
      suite: run.suite,
      agent: run.agent,
      agentVersion: run.agentVersion,
      model: run.model,
      suiteDigest: "sha256:suite",
      taskIds: ["t1"],
      repeat: 2,
      variants: run.variants,
    });
    for (const t of trials) store.addTrial(id, t);

    const fromStore = store.getResult(id);
    expect(fromStore).toMatchObject({
      id: String(id),
      suite: { digest: "sha256:suite" },
      repeat: 2,
    });
    expect(fromStore?.arms.map((a) => a.score.passes)).toEqual([1, 2]);
    expect(parseBenchResult(JSON.parse(JSON.stringify(fromStore)))).toStrictEqual(fromStore);
    expect(store.getResult(String(id))).toStrictEqual(fromStore);
    expect(store.latestResult()).toStrictEqual(fromStore);
    expect(store.getResult(999)).toBeUndefined();
    expect(store.getResult("abc")).toBeUndefined();
    store.close();
  });

  it("returns undefined from an empty store", () => {
    const store = new ResultStore(":memory:");
    expect(store.latestResult()).toBeUndefined();
    store.close();
  });
});
