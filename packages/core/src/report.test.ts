import { describe, expect, it } from "vitest";
import { formatReport, formatTrialLine, summarize } from "./report.js";
import type { RunRecord, TrialRecord } from "./store.js";

const t = (over: Partial<TrialRecord>): TrialRecord => ({
  variant: "baseline",
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
  agent: "claude-code",
  startedAt: "2026-10-03T00:00:00.000Z",
  variants: [
    { label: "baseline" },
    {
      label: "with-skill",
      skillName: "demo",
      skillVersion: "1.0.0",
      skillDigest: "sha256:0123456789abcdef0123",
    },
  ],
};

describe("summarize", () => {
  it("counts errored and timed-out trials as failures in the denominator", () => {
    const [baseline] = summarize([
      t({ passed: true }),
      t({ passed: false, status: "error" }),
      t({ passed: false, status: "timeout" }),
    ]);
    expect(baseline).toMatchObject({ variant: "baseline", trials: 3, passes: 1 });
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

  it("orders variants by the given order, else by first appearance, and skips empty ones", () => {
    const trials = [t({ variant: "b" }), t({ variant: "a" })];
    expect(summarize(trials).map((s) => s.variant)).toEqual(["b", "a"]);
    expect(summarize(trials, ["a", "b", "never-ran"]).map((s) => s.variant)).toEqual(["a", "b"]);
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
  it("lists each variant's source, per-repeat marks per task, then the comparison table", () => {
    const trials = [
      t({ variant: "baseline", repeatIdx: 1, passed: false, tokens: 31200, durationMs: 74000 }),
      t({ variant: "baseline", repeatIdx: 2, passed: true, tokens: 31200, durationMs: 74000 }),
      t({ variant: "with-skill", repeatIdx: 1, tokens: 18900, durationMs: 41000 }),
      t({ variant: "with-skill", repeatIdx: 2, tokens: 18900, durationMs: 41000 }),
    ];
    const out = formatReport(run, trials);
    expect(out).toContain("baseline: no skill");
    expect(out).toContain("with-skill: demo@1.0.0 (sha256:0123456789ab)");
    expect(out).toContain("[baseline]    t1  ✗ ✓");
    expect(out).toContain("[with-skill]  t1  ✓ ✓");
    expect(out).toMatch(/baseline\s+1\/2\s+31\.2k\s+74s/);
    expect(out).toMatch(/with-skill\s+2\/2\s+18\.9k\s+41s/);
  });

  it("handles a skill variant without a version and agent/model details", () => {
    const out = formatReport(
      {
        ...run,
        agentVersion: "2.1.0",
        model: "haiku",
        variants: [
          { label: "x@abcd1234", skillName: "x", skillDigest: "sha256:abcd1234ffff0000aaaa" },
        ],
      },
      [t({ variant: "x@abcd1234" })],
    );
    expect(out).toContain("agent claude-code 2.1.0 · model haiku");
    expect(out).toContain("x@abcd1234: x (sha256:abcd1234ffff)");
  });

  it("does not repeat the skill reference when the label already is name@version", () => {
    const out = formatReport(
      {
        ...run,
        variants: [
          {
            label: "demo@0.9.0",
            skillName: "demo",
            skillVersion: "0.9.0",
            skillDigest: "sha256:1111111111112222",
          },
          {
            label: "demo@1.0.0",
            skillName: "demo",
            skillVersion: "1.0.0",
            skillDigest: "sha256:3333333333334444",
          },
        ],
      },
      [t({ variant: "demo@0.9.0" }), t({ variant: "demo@1.0.0" })],
    );
    expect(out).toContain("  demo@0.9.0: sha256:111111111111\n");
    expect(out).toContain("  demo@1.0.0: sha256:333333333333\n");
  });
});
