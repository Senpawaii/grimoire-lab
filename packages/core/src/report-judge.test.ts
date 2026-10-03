import { describe, expect, it } from "vitest";
import { formatReport, summarize } from "./report.js";
import type { RunRecord, TrialRecord } from "./store.js";

const trial = (variant: string, score?: number): TrialRecord => ({
  variant,
  taskId: "t",
  repeatIdx: 1,
  status: "completed",
  passed: true,
  durationMs: 1000,
  finalMessage: "",
  transcriptPath: "x",
  assertions: [
    { type: "file_exists", passed: true, detail: "" },
    ...(score === undefined ? [] : [{ type: "judge" as const, passed: true, detail: "", score }]),
  ],
});

const run: RunRecord = {
  id: 1,
  suite: "s",
  agent: "a",
  startedAt: "2026-10-03T00:00:00.000Z",
  variants: [{ label: "baseline" }, { label: "other" }],
};

describe("judge scores in reports", () => {
  it("averages judge scores per variant and ignores unjudged trials", () => {
    const [a, b] = summarize([trial("a", 5), trial("a", 3), trial("a"), trial("b")]);
    expect(a?.meanJudgeScore).toBe(4);
    expect(b?.meanJudgeScore).toBeUndefined();
  });

  it("adds a judge column only when some variant was judged", () => {
    const judged = formatReport(run, [trial("baseline", 2), trial("other", 5)]);
    expect(judged).toMatch(/mean cost\s+judge/);
    expect(judged).toMatch(/baseline\s+1\/1.*2\.0\/5/);
    expect(judged).toMatch(/other\s+1\/1.*5\.0\/5/);

    const plain = formatReport(run, [trial("baseline"), trial("other")]);
    expect(plain).not.toContain("judge");
  });

  it("shows a dash for a variant with no judged trials when another one has scores", () => {
    const out = formatReport(run, [trial("baseline", 4), trial("other")]);
    expect(out).toMatch(/other\s+1\/1.*\s-$/m);
  });
});
