import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchProposal, benchSkill } from "./bench.js";
import { evidenceFor } from "./compare.js";
import { ResultStore } from "./store.js";
import { parseSuite } from "./suite.js";
import type { AgentAdapter, RunResult, Skill } from "./types.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bench-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const mkSkill = (version: string, digest: string): Skill => ({
  dir: "/skill",
  name: "demo",
  description: "d",
  version,
  digest,
});
const v1 = mkSkill("1.0.0", "sha256:v1");
const v2 = mkSkill("1.1.0", "sha256:v2");
const v3 = mkSkill("1.2.0", "sha256:v3");

const suite = (repeat = 3) =>
  parseSuite(
    `
suite: s
defaults: { repeat: ${repeat} }
tasks:
  - id: t1
    prompt: go
    assertions: [{ type: file_exists, path: out.txt }]
`,
    tmp,
  );

interface FakeOpts {
  /** Skill digests that make the agent produce out.txt (a baseline has no digest). */
  good?: string[];
  /** Trials for which this returns true end in an adapter error. */
  crash?: (digest: string | undefined) => boolean;
  available?: boolean;
  afterRun?: () => void;
}

function fake(opts: FakeOpts = {}) {
  const installed = new Map<string, string>();
  const adapter: AgentAdapter = {
    id: "fake",
    detect: async () => ({ available: opts.available ?? true, version: "9.9" }),
    install: async (s, ws) => {
      installed.set(ws.root, s.digest);
    },
    run: async (_req, ws): Promise<RunResult> => {
      const digest = installed.get(ws.root);
      opts.afterRun?.();
      const base = { transcript: [], finalMessage: "", durationMs: 5, rawOutput: "" };
      if (opts.crash?.(digest)) {
        return { ...base, status: "error", error: "rate limited", usage: { tokens: 1 } };
      }
      if (digest !== undefined && opts.good?.includes(digest)) {
        await writeFile(join(ws.dir, "out.txt"), "x");
      }
      return { ...base, status: "completed", usage: { tokens: 10 } };
    },
  };
  return adapter;
}

const base = () => ({ suite: suite(), outDir: join(tmp, "out") });

describe("benchSkill", () => {
  it("runs baseline vs skill by default and returns a BenchResult with the comparison", async () => {
    const seen: [string, string, number][] = [];
    const result = await benchSkill({
      ...base(),
      skill: v1,
      adapter: fake({ good: [v1.digest] }),
      model: "haiku",
      onTrial: (t, arm) => seen.push([arm, t.taskId, t.repeatIdx]),
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.id).toBe("1");
    expect(result.repeat).toBe(3);
    expect(result.suite).toMatchObject({ name: "s", taskIds: ["t1"] });
    expect(result.suite.digest).toMatch(/^sha256:/);
    expect(result.arms.map((a) => a.label)).toEqual(["baseline", "with-skill"]);
    expect(result.arms[0]?.skill).toBeUndefined();
    expect(result.arms[1]?.skill).toEqual({ name: "demo", version: "1.0.0", digest: v1.digest });
    expect(result.arms[0]?.agent).toEqual({ id: "fake", version: "9.9", model: "haiku" });
    expect(result.arms[0]?.score).toMatchObject({ trials: 3, passes: 0, passRate: 0 });
    expect(result.arms[1]?.score).toMatchObject({ trials: 3, passes: 3, passRate: 1 });
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({
      kind: "skill-vs-baseline",
      subject: "with-skill",
      reference: "baseline",
      deltas: { passRate: 1 },
      n: { subject: 3, reference: 3, subjectErrors: 0, referenceErrors: 0 },
    });
    // Variants are interleaved within each repeat.
    expect(seen).toEqual([
      ["baseline", "t1", 1],
      ["with-skill", "t1", 1],
      ["baseline", "t1", 2],
      ["with-skill", "t1", 2],
      ["baseline", "t1", 3],
      ["with-skill", "t1", 3],
    ]);
    expect(existsSync(join(tmp, "out", "runs", "1"))).toBe(true);
    expect(evidenceFor(result, v1).vsBaseline?.subject).toBe("with-skill");
  });

  it("honors the suite repeat count unless `repeat` overrides it", async () => {
    const result = await benchSkill({
      ...base(),
      skill: v1,
      adapter: fake(),
      repeat: 1,
    });
    expect(result.repeat).toBe(1);
    expect(result.arms[0]?.score.trials).toBe(1);
  });

  it("persists into a caller's store and leaves it open", async () => {
    const store = new ResultStore(join(tmp, "db", "results.db"));
    const result = await benchSkill({ ...base(), skill: v1, adapter: fake(), store });
    expect(store.getResult(result.id)).toEqual(result);
    expect(store.listTrials(1)).toHaveLength(6);
    const second = await benchSkill({ ...base(), skill: v1, adapter: fake(), store });
    expect(second.id).toBe("2");
    store.close();
  });

  it("does not persist without a store (results live only in the return value)", async () => {
    const result = await benchSkill({ ...base(), skill: v1, adapter: fake() });
    expect(result.arms).toHaveLength(2);
    expect(existsSync(join(tmp, "out", "results.db"))).toBe(false);
  });

  it("with `against` compares two versions, older first, and adds no baseline", async () => {
    const result = await benchSkill({
      ...base(),
      skill: v2,
      against: v1,
      adapter: fake({ good: [v2.digest] }),
    });
    expect(result.arms.map((a) => a.label)).toEqual(["demo@1.0.0", "demo@1.1.0"]);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({
      kind: "version-vs-version",
      subject: "demo@1.1.0",
      reference: "demo@1.0.0",
      deltas: { passRate: 1 },
    });
    expect(evidenceFor(result, v2).vsPrevious?.subject).toBe("demo@1.1.0");
  });

  it("with `against` and `baseline: true` runs three arms and three comparisons", async () => {
    const result = await benchSkill({
      ...base(),
      skill: v2,
      against: v1,
      baseline: true,
      adapter: fake({ good: [v1.digest, v2.digest] }),
    });
    expect(result.arms.map((a) => a.label)).toEqual(["baseline", "demo@1.0.0", "demo@1.1.0"]);
    expect(result.comparisons.map((c) => [c.kind, c.subject, c.reference])).toEqual([
      ["skill-vs-baseline", "demo@1.0.0", "baseline"],
      ["skill-vs-baseline", "demo@1.1.0", "baseline"],
      ["version-vs-version", "demo@1.1.0", "demo@1.0.0"],
    ]);
  });

  it("rejects a run with nothing to compare with, or identical versions, before storing anything", async () => {
    const store = new ResultStore(":memory:");
    await expect(
      benchSkill({ ...base(), skill: v1, baseline: false, adapter: fake(), store }),
    ).rejects.toThrow(/Nothing to compare with/);
    await expect(
      benchSkill({ ...base(), skill: v1, against: v1, adapter: fake(), store }),
    ).rejects.toThrow(/identical contents/);
    expect(store.getRun()).toBeUndefined();
    store.close();
  });

  it("rejects when the agent is unavailable", async () => {
    await expect(
      benchSkill({ ...base(), skill: v1, adapter: fake({ available: false }) }),
    ).rejects.toThrow(/not available/);
  });

  it("counts infrastructure errors in Score.errors and Comparison.n without changing passRate", async () => {
    const result = await benchSkill({
      ...base(),
      skill: v1,
      // Baseline trials crash (a rate limit), the skill passes.
      adapter: fake({ good: [v1.digest], crash: (d) => d === undefined }),
    });
    const [baseline, withSkill] = result.arms;
    expect(baseline?.score).toMatchObject({ trials: 3, passes: 0, passRate: 0, errors: 3 });
    expect(baseline?.tasks[0]?.score.errors).toBe(3);
    expect(baseline?.tasks[0]?.trials.every((t) => t.infraError && t.status === "error")).toBe(
      true,
    );
    expect(withSkill?.score.errors).toBe(0);
    expect(result.comparisons[0]?.n).toEqual({
      subject: 3,
      reference: 3,
      subjectErrors: 0,
      referenceErrors: 3,
    });
  });

  describe("signal", () => {
    it("rejects with an AbortError before creating a run when already aborted", async () => {
      const store = new ResultStore(":memory:");
      const ctl = new AbortController();
      ctl.abort();
      await expect(
        benchSkill({ ...base(), skill: v1, adapter: fake(), store, signal: ctl.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(store.getRun()).toBeUndefined();
      store.close();
    });

    it("stops between trials, rejects with an AbortError and keeps the stored trials", async () => {
      const store = new ResultStore(":memory:");
      const ctl = new AbortController();
      let trials = 0;
      const promise = benchSkill({
        ...base(),
        skill: v1,
        adapter: fake(),
        store,
        signal: ctl.signal,
        onTrial: () => {
          if (++trials === 2) ctl.abort();
        },
      });
      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
      expect(trials).toBe(2);
      expect(store.listTrials(1)).toHaveLength(2);
      expect(store.getRun(1)?.variants).toHaveLength(2);
      store.close();
    });

    it("lets a plain in-memory run abort too, and surfaces a custom reason", async () => {
      const ctl = new AbortController();
      const reason = new Error("user cancelled");
      await expect(
        benchSkill({
          ...base(),
          skill: v1,
          adapter: fake({ afterRun: () => ctl.abort(reason) }),
          signal: ctl.signal,
        }),
      ).rejects.toBe(reason);
    });
  });
});

describe("benchProposal", () => {
  it("benchmarks the candidate against the current version (subject = candidate)", async () => {
    const p = await benchProposal({
      ...base(),
      current: v1,
      candidate: v2,
      adapter: fake({ good: [v2.digest] }),
    });
    expect(p.current).toEqual({ name: "demo", version: "1.0.0", digest: v1.digest });
    expect(p.candidate).toEqual({ name: "demo", version: "1.1.0", digest: v2.digest });
    expect(p.result.arms.map((a) => a.label)).toEqual(["demo@1.0.0", "demo@1.1.0"]);
    expect(p.comparison).toEqual(p.result.comparisons[0]);
    expect(p.comparison).toMatchObject({
      kind: "version-vs-version",
      subject: "demo@1.1.0",
      reference: "demo@1.0.0",
      deltas: { passRate: 1 },
    });
  });

  it("with `baseline: true` adds a no-skill arm: three arms, three comparisons", async () => {
    const p = await benchProposal({
      ...base(),
      current: v1,
      candidate: v3,
      repeat: 5, // the default gate needs 5 countable trials per side
      baseline: true,
      adapter: fake({ good: [v1.digest] }),
    });
    expect(p.result.arms.map((a) => a.label)).toEqual(["baseline", "demo@1.0.0", "demo@1.2.0"]);
    expect(p.result.comparisons).toHaveLength(3);
    expect(p.comparison).toMatchObject({
      kind: "version-vs-version",
      subject: "demo@1.2.0",
      reference: "demo@1.0.0",
      deltas: { passRate: -1 },
      verdict: "worse",
    });
  });

  it("keeps the +digest label suffix when the candidate did not bump the version", async () => {
    const same = { ...v2, version: "1.0.0" };
    const p = await benchProposal({ ...base(), current: v1, candidate: same, adapter: fake() });
    expect(p.result.arms.map((a) => a.label)).toEqual(["demo@1.0.0+v1", "demo@1.0.0+v2"]);
  });

  it("throws on identical digests and forwards the store and onTrial", async () => {
    await expect(
      benchProposal({ ...base(), current: v1, candidate: { ...v1 }, adapter: fake() }),
    ).rejects.toThrow(/identical contents/);

    const store = new ResultStore(":memory:");
    let n = 0;
    await benchProposal({
      ...base(),
      current: v1,
      candidate: v2,
      adapter: fake(),
      store,
      onTrial: () => n++,
    });
    expect(n).toBe(6);
    expect(store.getRun(1)).toBeDefined();
    store.close();
  });

  it("counts infra errors of both versions in the comparison", async () => {
    const p = await benchProposal({
      ...base(),
      current: v1,
      candidate: v2,
      adapter: fake({ crash: (d) => d === v1.digest }),
    });
    expect(p.comparison.n).toEqual({
      subject: 3,
      reference: 3,
      subjectErrors: 0,
      referenceErrors: 3,
    });
  });
});
