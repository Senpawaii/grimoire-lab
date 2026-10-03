import { describe, expect, it } from "vitest";
import { formatReport, formatTrialLine, summarize } from "./report.js";
import type { RunRecord, TrialRecord } from "./store.js";

const t = (over: Partial<TrialRecord>): TrialRecord => ({
  cell: "baseline",
  taskId: "t1",
  repeatIdx: 1,
  status: "completed",
  passed: true,
  durationMs: 1000,
  finalMessage: "",
  transcriptPath: "x",
  assertions: [],
  ...over,
});

const run: RunRecord = {
  id: 7,
  suite: "s",
  skillName: "demo",
  skillVersion: "1.0.0",
  skillDigest: "sha256:0123456789abcdef0123",
  agent: "claude-code",
  startedAt: "2026-10-03T00:00:00.000Z",
};

describe("summarize", () => {
  it("counts errored and timed-out trials as failures in the denominator", () => {
    const [baseline] = summarize([
      t({ passed: true }),
      t({ passed: false, status: "error" }),
      t({ passed: false, status: "timeout" }),
    ]);
    expect(baseline).toMatchObject({ cell: "baseline", trials: 3, passes: 1 });
  });

  it("averages metrics only over trials that reported them", () => {
    const [s] = summarize([
      t({ tokens: 100, costUsd: 0.1, durationMs: 2000 }),
      t({ tokens: 300, costUsd: 0.3, durationMs: 4000 }),
      t({ tokens: undefined, costUsd: undefined, durationMs: 6000 }),
    ]);
    expect(s).toMatchObject({ meanTokens: 200, meanDurationMs: 4000 });
    expect(s?.meanCostUsd).toBeCloseTo(0.2);
  });

  it("omits cells that have no trials", () => {
    expect(summarize([t({ cell: "with-skill" })]).map((s) => s.cell)).toEqual(["with-skill"]);
  });
});

describe("formatTrialLine", () => {
  it("shows failed assertion details, and the status for non-completed trials", () => {
    const failed = t({
      passed: false,
      assertions: [{ type: "file_exists", passed: false, detail: "out.txt does not exist" }],
    });
    expect(formatTrialLine(failed)).toBe("[baseline] t1 #1 ✗  out.txt does not exist");
    expect(
      formatTrialLine(t({ passed: false, status: "timeout", error: "timed out after 5ms" })),
    ).toBe("[baseline] t1 #1 !  timeout: timed out after 5ms");
  });
});

describe("formatReport", () => {
  it("lists per-repeat marks per task and cell, then the comparison table", () => {
    const trials = [
      t({ cell: "baseline", repeatIdx: 1, passed: false, tokens: 31200, durationMs: 74000 }),
      t({ cell: "baseline", repeatIdx: 2, passed: true, tokens: 31200, durationMs: 74000 }),
      t({ cell: "with-skill", repeatIdx: 1, tokens: 18900, durationMs: 41000 }),
      t({ cell: "with-skill", repeatIdx: 2, tokens: 18900, durationMs: 41000 }),
    ];
    const out = formatReport(run, trials);
    expect(out).toContain("skill demo@1.0.0");
    expect(out).toContain("[baseline]    t1  ✗ ✓");
    expect(out).toContain("[with-skill]  t1  ✓ ✓");
    expect(out).toMatch(/baseline\s+1\/2\s+31\.2k\s+74s/);
    expect(out).toMatch(/with-skill\s+2\/2\s+18\.9k\s+41s/);
  });
});
