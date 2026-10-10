import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBench } from "./engine.js";
import { ResultStore, type TrialRecord } from "./store.js";
import { parseSuite } from "./suite.js";
import type { AgentAdapter, RunRequest, Skill } from "./types.js";
import { buildVariants } from "./variants.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "engine-judge-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const skill: Skill = { dir: "/skill", name: "demo", description: "d", digest: "sha256:1" };

const suite = (judge: string) =>
  parseSuite(
    `suite: s\ndefaults: { repeat: 1 }\ntasks:\n  - id: t\n    prompt: do it\n    assertions: [{ type: max, metric: durationMs, value: 1000 }]\n    judge:\n${judge}`,
    tmp,
  );

/**
 * Task runs (tools undefined) return a final message; judge runs (tools: []) return `verdict`
 * for a given variant call order.
 */
function adapter(opts: { verdicts: string[]; taskStatus?: "completed" | "timeout" }) {
  const judgeRequests: RunRequest[] = [];
  let judgeCalls = 0;
  const a: AgentAdapter = {
    id: "fake",
    detect: async () => ({ available: true }),
    install: async () => {},
    run: async (req) => {
      const isJudge = req.tools !== undefined;
      if (isJudge) judgeRequests.push(req);
      return {
        status: isJudge ? "completed" : (opts.taskStatus ?? "completed"),
        transcript: [],
        finalMessage: isJudge ? (opts.verdicts[judgeCalls++] ?? "") : "agent says hi",
        durationMs: 5,
        rawOutput: "",
        usage: isJudge ? { tokens: 999_999 } : { tokens: 10 },
      };
    },
  };
  return { a, judgeRequests };
}

async function bench(a: AgentAdapter, s = suite("      rubric: r\n      passScore: 4")) {
  const store = new ResultStore(":memory:");
  const seen: TrialRecord[] = [];
  const runId = await runBench({
    suite: s,
    variants: buildVariants(skill),
    adapter: a,
    store,
    outDir: tmp,
    onTrial: (t) => seen.push(t),
  });
  return { seen, store, runId };
}

describe("runBench with a judge", () => {
  it("appends the judge result after the assertions, and passes only if both pass", async () => {
    const { a, judgeRequests } = adapter({
      verdicts: ['{"score": 5, "reasoning": "great"}', '{"score": 2, "reasoning": "weak"}'],
    });
    const { seen } = await bench(a);

    expect(seen.map((t) => t.passed)).toEqual([true, false]);
    expect(seen[0]?.assertions.map((x) => x.type)).toEqual(["max", "judge"]);
    expect(seen[0]?.assertions[1]).toMatchObject({ passed: true, score: 5 });
    expect(seen[1]?.assertions[1]).toMatchObject({ passed: false, score: 2 });
    expect(judgeRequests).toHaveLength(2);
  });

  it("judges even when a deterministic assertion failed, so scores stay comparable", async () => {
    const { a } = adapter({ verdicts: ['{"score": 5}', '{"score": 5}'] });
    const s = parseSuite(
      "suite: s\ndefaults: { repeat: 1 }\ntasks:\n  - id: t\n    prompt: p\n    assertions: [{ type: max, metric: durationMs, value: 1 }]\n    judge:\n      rubric: r",
      tmp,
    );
    const { seen } = await bench(a, s);
    expect(
      seen.every((t) => !t.passed && t.assertions.some((x) => x.type === "judge" && x.score === 5)),
    ).toBe(true);
  });

  it("does not count judge usage in the trial's tokens", async () => {
    const { a } = adapter({ verdicts: ['{"score": 5}', '{"score": 5}'] });
    const { seen } = await bench(a);
    expect(seen.every((t) => t.tokens === 10)).toBe(true);
  });

  it("fails the trial, with the reason, when the judge gives no usable verdict", async () => {
    const { a } = adapter({ verdicts: ["no idea", "still no idea"] });
    const { seen } = await bench(a);
    expect(seen.every((t) => !t.passed)).toBe(true);
    expect(seen[0]?.assertions[1]).toMatchObject({ type: "judge", passed: false });
  });

  it("skips the judge for trials where the agent did not complete", async () => {
    const { a, judgeRequests } = adapter({ verdicts: [], taskStatus: "timeout" });
    const { seen } = await bench(a);
    expect(judgeRequests).toHaveLength(0);
    expect(seen.every((t) => t.status === "timeout" && t.assertions.length === 0)).toBe(true);
  });

  it("persists judge scores so they survive a reload", async () => {
    const { a } = adapter({ verdicts: ['{"score": 4, "reasoning": "ok"}', '{"score": 3}'] });
    const { store, runId } = await bench(a);
    const scores = store
      .listTrials(runId)
      .map((t) => t.assertions.find((x) => x.type === "judge")?.score);
    expect(scores).toEqual([4, 3]);
  });

  it("runs without a judge call when the task has none", async () => {
    const { a, judgeRequests } = adapter({ verdicts: [] });
    const s = parseSuite(
      "suite: s\ndefaults: { repeat: 1 }\ntasks:\n  - id: t\n    prompt: p\n    assertions: [{ type: max, metric: durationMs, value: 1000 }]",
      tmp,
    );
    const { seen } = await bench(a, s);
    expect(judgeRequests).toHaveLength(0);
    expect(seen.every((t) => t.passed)).toBe(true);
  });
});
