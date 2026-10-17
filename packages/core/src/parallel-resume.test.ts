import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BenchSkillOptions, benchSkill, resumeBench } from "./bench.js";
import { ResumeMismatch } from "./engine.js";
import type { BenchResult } from "./result.js";
import { ResultStore } from "./store.js";
import { parseSuite, type Suite } from "./suite.js";
import { digestSuite } from "./suite-digest.js";
import type { AgentAdapter, Skill } from "./types.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "parallel-resume-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const mkSkill = (version: string): Skill => ({
  dir: "/skill",
  name: "demo",
  description: "d",
  version,
  digest: `sha256:${version}`,
});
const skill = mkSkill("1.0.0");
const outDir = () => join(tmp, "out");

/** One task per id; the prompt is the id, so the adapter can tell which task it is running. */
const suiteOf = (ids: string[], repeat: number, promptSuffix = ""): Suite =>
  parseSuite(
    `suite: s\ndefaults: { repeat: ${repeat} }\ntasks:\n${ids
      .map(
        (id) =>
          `  - id: ${id}\n    prompt: ${id}${promptSuffix}\n    assertions: [{ type: file_exists, path: out.txt }]\n`,
      )
      .join("")}`,
    tmp,
  );

/** Lets sibling trials make progress (workspace setup) without a wall-clock wait. */
const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

interface FakeOpts {
  id?: string;
  available?: boolean;
  /** Runs block until `open()`; without it each run yields a few event-loop turns. */
  gated?: boolean;
}

function fake(o: FakeOpts = {}) {
  const installed = new Set<string>();
  const state = {
    runs: 0,
    detects: 0,
    inFlight: 0,
    maxInFlight: 0,
    /** "<prompt>:<skill|base>" in the order runs began. */
    started: [] as string[],
    models: [] as (string | undefined)[],
  };
  let open = () => {};
  const gate = o.gated ? new Promise<void>((r) => (open = r)) : undefined;
  const waiters: { n: number; resolve: () => void }[] = [];
  /** Resolves once `n` runs have begun. */
  const started = (n: number) =>
    new Promise<void>((resolve) => {
      if (state.started.length >= n) resolve();
      else waiters.push({ n, resolve });
    });
  const adapter: AgentAdapter = {
    id: o.id ?? "fake",
    detect: async () => {
      state.detects++;
      return { available: o.available ?? true, version: "9.9" };
    },
    install: async (_s, ws) => {
      installed.add(ws.root);
    },
    run: async (req, ws) => {
      const withSkill = installed.has(ws.root);
      state.runs++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      state.started.push(`${req.prompt}:${withSkill ? "skill" : "base"}`);
      state.models.push(req.model);
      for (const w of waiters) if (state.started.length >= w.n) w.resolve();
      try {
        if (gate) await gate;
        else for (let i = 0; i < 3; i++) await yieldTurn();
        if (withSkill) await writeFile(join(ws.dir, "out.txt"), "x");
      } finally {
        state.inFlight--;
      }
      return {
        status: "completed",
        transcript: [],
        finalMessage: "ok",
        durationMs: 5,
        rawOutput: "",
        usage: { tokens: 10 },
      };
    },
  };
  return { adapter, state, started, open: () => open() };
}

const shape = (r: BenchResult) => ({ suite: r.suite, arms: r.arms, comparisons: r.comparisons });

describe("concurrency", () => {
  it("never exceeds the bound and returns the same result as a sequential run", async () => {
    const suite = suiteOf(["a", "b"], 3);
    const seq = fake();
    const sequential = await benchSkill({ suite, skill, adapter: seq.adapter, outDir: outDir() });
    const par = fake({ gated: true });
    const running = benchSkill({
      suite,
      skill,
      adapter: par.adapter,
      outDir: outDir(),
      concurrency: 4,
    });
    await par.started(4);
    expect(par.state.inFlight).toBe(4);
    par.open();
    const parallel = await running;

    expect(seq.state.maxInFlight).toBe(1);
    expect(par.state.maxInFlight).toBe(4);
    expect(par.state.runs).toBe(12);
    expect(shape(parallel)).toEqual(shape(sequential));
    expect(parallel.arms[1]?.tasks[0]?.trials.map((t) => t.repeatIdx)).toEqual([1, 2, 3]);
  });

  it("starts trials in task, repeat, variant order", async () => {
    const f = fake({ gated: true });
    const done = benchSkill({
      suite: suiteOf(["a", "b"], 1),
      skill,
      adapter: f.adapter,
      outDir: outDir(),
      concurrency: 2,
    });
    await f.started(2);
    expect(f.state.inFlight).toBe(2);
    expect([...f.state.started].sort()).toEqual(["a:base", "a:skill"]);
    f.open();
    await done;
    expect(f.state.runs).toBe(4);
    expect(f.state.maxInFlight).toBe(2); // the bound held while the other two trials were pending
  });

  it("keeps the variants of a repeat together", async () => {
    const f = fake({ gated: true });
    const done = benchSkill({
      suite: suiteOf(["a"], 2),
      skill,
      adapter: f.adapter,
      outDir: outDir(),
      concurrency: 2,
    });
    await f.started(2);
    expect([...f.state.started].sort()).toEqual(["a:base", "a:skill"]);
    f.open();
    await done;
  });

  it("on abort lets running trials finish and be stored, starts none, then rejects", async () => {
    const store = new ResultStore(":memory:");
    const f = fake({ gated: true });
    const ac = new AbortController();
    const settled = expect(
      benchSkill({
        suite: suiteOf(["a"], 3),
        skill,
        adapter: f.adapter,
        outDir: outDir(),
        store,
        concurrency: 2,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await f.started(2);
    ac.abort();
    f.open();
    await settled;
    expect(f.state.runs).toBe(2);
    expect(store.listTrials(1)).toHaveLength(2);
    store.close();
  });

  it("a failing onTrial stops new trials, drains the running ones and rethrows", async () => {
    const store = new ResultStore(":memory:");
    const f = fake();
    await expect(
      benchSkill({
        suite: suiteOf(["a"], 3),
        skill,
        adapter: f.adapter,
        outDir: outDir(),
        store,
        concurrency: 2,
        onTrial: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(f.state.runs).toBe(2);
    expect(store.listTrials(1)).toHaveLength(2);
    store.close();
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects concurrency %s before creating a run", async (n) => {
    const store = new ResultStore(":memory:");
    const f = fake();
    await expect(
      benchSkill({
        suite: suiteOf(["a"], 1),
        skill,
        adapter: f.adapter,
        outDir: outDir(),
        store,
        concurrency: n,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(store.getRun()).toBeUndefined();
    expect(f.state.detects).toBe(0);
    store.close();
  });
});

describe("resumeBench", () => {
  const suite = suiteOf(["a", "b"], 2); // 2 tasks x 2 repeats x 2 arms = 8 trials

  /** A run that was aborted after `after` trials; returns the trials it reported. */
  async function abortedRun(
    store: ResultStore,
    after: number,
    opts: Partial<BenchSkillOptions> = {},
  ) {
    const ac = new AbortController();
    const seen: string[] = [];
    await expect(
      benchSkill({
        suite,
        skill,
        adapter: fake().adapter,
        outDir: outDir(),
        model: "haiku",
        store,
        signal: ac.signal,
        onTrial: (t, arm) => {
          seen.push(`${arm}|${t.taskId}|${t.repeatIdx}`);
          if (seen.length === after) ac.abort();
        },
        ...opts,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    return seen;
  }

  const fresh = () =>
    benchSkill({ suite, skill, adapter: fake().adapter, outDir: outDir(), model: "haiku" });

  it("runs only the missing trials, appends them to the same run and returns the full result", async () => {
    const store = new ResultStore(":memory:");
    const first = await abortedRun(store, 3);
    expect(store.listTrials(1)).toHaveLength(3);

    const f = fake();
    const again: string[] = [];
    const result = await resumeBench({
      runId: 1,
      store,
      suite,
      skills: [skill],
      adapter: f.adapter,
      outDir: outDir(),
      onTrial: (t, arm) => again.push(`${arm}|${t.taskId}|${t.repeatIdx}`),
    });

    expect(f.state.runs).toBe(5);
    expect(f.state.models.every((m) => m === "haiku")).toBe(true); // the run's model, not an option
    expect(again).toHaveLength(5);
    expect(new Set([...first, ...again]).size).toBe(8);
    expect(result.id).toBe("1");
    expect(store.listTrials(1)).toHaveLength(8);
    expect(shape(result)).toEqual(shape(await fresh()));
    expect(
      (await readdir(join(outDir(), "runs", "1"))).filter((n) => n.endsWith(".jsonl")),
    ).toHaveLength(8);
    store.close();
  });

  it("resumes with a bounded pool", async () => {
    const store = new ResultStore(":memory:");
    await abortedRun(store, 1);
    const f = fake();
    const result = await resumeBench({
      runId: 1,
      store,
      suite,
      skills: [skill],
      adapter: f.adapter,
      outDir: outDir(),
      concurrency: 3,
    });
    expect(f.state.runs).toBe(7);
    expect(f.state.maxInFlight).toBeGreaterThan(1);
    expect(f.state.maxInFlight).toBeLessThanOrEqual(3);
    expect(shape(result)).toEqual(shape(await fresh()));
    store.close();
  });

  it("an aborted resume can be resumed again", async () => {
    const store = new ResultStore(":memory:");
    await abortedRun(store, 2);
    const ac = new AbortController();
    let n = 0;
    const o = { runId: 1, store, suite, skills: [skill], outDir: outDir() };
    await expect(
      resumeBench({
        ...o,
        adapter: fake().adapter,
        signal: ac.signal,
        onTrial: () => {
          if (++n === 2) ac.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(store.listTrials(1)).toHaveLength(4);

    const f = fake();
    const result = await resumeBench({ ...o, adapter: f.adapter });
    expect(f.state.runs).toBe(4);
    expect(shape(result)).toEqual(shape(await fresh()));
    store.close();
  });

  it("is a no-op on a complete run: nothing runs and the adapter is not called", async () => {
    const store = new ResultStore(":memory:");
    const original = await benchSkill({
      suite,
      skill,
      adapter: fake().adapter,
      outDir: outDir(),
      store,
    });
    const f = fake();
    const result = await resumeBench({
      runId: 1,
      store,
      suite,
      skills: [skill],
      adapter: f.adapter,
      outDir: outDir(),
    });
    expect(f.state.runs).toBe(0);
    expect(f.state.detects).toBe(0);
    expect(result).toEqual(original);
    expect(store.listTrials(1)).toHaveLength(8);
    store.close();
  });

  it("matches skills by digest, ignores extras, and resumes version-vs-version runs with a baseline", async () => {
    const v1 = mkSkill("1.0.0");
    const v2 = mkSkill("1.1.0");
    const store = new ResultStore(":memory:");
    const ac = new AbortController();
    let n = 0;
    await expect(
      benchSkill({
        suite,
        skill: v2,
        against: v1,
        baseline: true,
        adapter: fake().adapter,
        outDir: outDir(),
        store,
        signal: ac.signal,
        onTrial: () => {
          if (++n === 4) ac.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const f = fake();
    const result = await resumeBench({
      runId: 1,
      store,
      suite,
      skills: [mkSkill("9.9.9"), v2, v1],
      adapter: f.adapter,
      outDir: outDir(),
    });
    expect(f.state.runs).toBe(8);
    expect(result.arms.map((a) => a.label)).toEqual(["baseline", "demo@1.0.0", "demo@1.1.0"]);
    expect(result.arms.map((a) => a.score.trials)).toEqual([4, 4, 4]);
    store.close();
  });

  describe("refuses, before running anything, when", () => {
    async function expectRefused(
      kind: ResumeMismatch["kind"],
      o: { suite?: Suite; skills?: Skill[]; adapter?: AgentAdapter },
    ) {
      const store = new ResultStore(":memory:");
      await abortedRun(store, 2);
      const f = fake();
      const err = await resumeBench({
        runId: 1,
        store,
        suite: o.suite ?? suite,
        skills: o.skills ?? [skill],
        adapter: o.adapter ?? f.adapter,
        outDir: outDir(),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResumeMismatch);
      expect((err as ResumeMismatch).kind).toBe(kind);
      expect(f.state.runs).toBe(0);
      expect(store.listTrials(1)).toHaveLength(2);
      store.close();
      return (err as ResumeMismatch).message;
    }

    it("the suite changed", async () => {
      const msg = await expectRefused("suite", { suite: suiteOf(["a", "b"], 2, " edited") });
      expect(msg).toContain(await digestSuite(suite));
    });

    it("a skill is missing", async () => {
      expect(await expectRefused("skill", { skills: [] })).toContain(skill.digest);
    });

    it("a skill was edited since", async () => {
      await expectRefused("skill", { skills: [{ ...skill, digest: "sha256:edited" }] });
    });

    it("the agent differs", async () => {
      const other = fake({ id: "other" });
      await expectRefused("agent", { adapter: other.adapter });
    });
  });

  describe("fails clearly when", () => {
    const base = () => ({ suite, skills: [skill], adapter: fake().adapter, outDir: outDir() });

    it("the run does not exist", async () => {
      const store = new ResultStore(":memory:");
      await expect(resumeBench({ ...base(), runId: 9, store })).rejects.toThrow("No run with id 9");
      store.close();
    });

    it("the run predates suite digests", async () => {
      const store = new ResultStore(":memory:");
      const id = store.createRun({
        suite: "s",
        agent: "fake",
        variants: [{ label: "baseline" }, { label: "x" }],
      });
      await expect(resumeBench({ ...base(), runId: id, store })).rejects.toThrow(
        /before suite digests were stored/,
      );
      store.close();
    });

    it("an arm has a skill without a recorded digest", async () => {
      const store = new ResultStore(":memory:");
      const id = store.createRun({
        suite: "s",
        agent: "fake",
        suiteDigest: await digestSuite(suite),
        taskIds: ["a", "b"],
        repeat: 2,
        variants: [{ label: "baseline" }, { label: "x", skillName: "demo" }],
      });
      await expect(resumeBench({ ...base(), runId: id, store })).rejects.toThrow(
        /no digest recorded for variant "x"/,
      );
      store.close();
    });

    it("the signal is already aborted", async () => {
      const store = new ResultStore(":memory:");
      await abortedRun(store, 2);
      await expect(
        resumeBench({ ...base(), runId: 1, store, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(store.listTrials(1)).toHaveLength(2);
      store.close();
    });

    it("the agent is unavailable", async () => {
      const store = new ResultStore(":memory:");
      await abortedRun(store, 2);
      await expect(
        resumeBench({
          ...base(),
          runId: 1,
          store,
          adapter: fake({ available: false }).adapter,
        }),
      ).rejects.toThrow(/not available/);
      store.close();
    });

    it("concurrency is not a positive integer", async () => {
      const store = new ResultStore(":memory:");
      await abortedRun(store, 2);
      await expect(
        resumeBench({ ...base(), runId: 1, store, concurrency: 0 }),
      ).rejects.toBeInstanceOf(RangeError);
      store.close();
    });
  });

  it("existing transcripts of finished trials are left alone", async () => {
    const store = new ResultStore(":memory:");
    await abortedRun(store, 2);
    const dir = join(outDir(), "runs", "1");
    const before = (await readdir(dir)).sort();
    expect(existsSync(dir)).toBe(true);
    await resumeBench({
      runId: 1,
      store,
      suite,
      skills: [skill],
      adapter: fake().adapter,
      outDir: outDir(),
    });
    const after = await readdir(dir);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.length).toBe(16); // 8 trials x (.jsonl + .raw.txt)
    store.close();
  });
});
