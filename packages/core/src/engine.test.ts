import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBench } from "./engine.js";
import { ResultStore, type TrialRecord } from "./store.js";
import { parseSuite } from "./suite.js";
import type { AgentAdapter, RunResult, Skill, Workspace } from "./types.js";
import { buildVariants, type Variant } from "./variants.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "engine-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const skill: Skill = {
  dir: "/skill",
  name: "demo",
  description: "d",
  version: "1.0.0",
  digest: "sha256:1",
};

const suite = (assertions: string, extra = "") =>
  parseSuite(
    `
suite: s
defaults: { repeat: 2 }
tasks:
  - id: t1
    prompt: go
    ${extra}
    assertions: ${assertions}
`,
    tmp,
  );

interface FakeOpts {
  /** Called inside run(); can write files, throw, or return a custom result. */
  onRun?: (ws: Workspace, installed: boolean) => Promise<Partial<RunResult> | undefined>;
  available?: boolean;
}

function fakeAdapter(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const installed = new Set<string>();
  const adapter: AgentAdapter = {
    id: "fake",
    detect: async () => ({ available: opts.available ?? true, version: "9.9" }),
    install: async (_s, ws) => {
      calls.push("install");
      installed.add(ws.root);
    },
    run: async (_req, ws) => {
      const isInstalled = installed.has(ws.root);
      calls.push(isInstalled ? "run:with-skill" : "run:baseline");
      const custom = await opts.onRun?.(ws, isInstalled);
      return {
        status: "completed",
        transcript: isInstalled ? [{ type: "skill_loaded", skill: "demo" }] : [],
        finalMessage: "ok",
        durationMs: 10,
        rawOutput: "raw",
        usage: { tokens: 50 },
        ...custom,
      };
    },
  };
  return { adapter, calls };
}

async function bench(
  adapter: AgentAdapter,
  s = suite("[{ type: file_exists, path: out.txt }]"),
  variants: Variant[] = buildVariants(skill),
) {
  const store = new ResultStore(":memory:");
  const seen: TrialRecord[] = [];
  const runId = await runBench({
    variants,
    suite: s,
    adapter,
    store,
    outDir: tmp,
    onTrial: (t) => seen.push(t),
  });
  return { store, runId, seen };
}

const writeOut: FakeOpts["onRun"] = async (ws) => {
  await writeFile(join(ws.dir, "out.txt"), "x");
  return undefined;
};

describe("runBench", () => {
  it("installs the skill only in the with-skill cell and interleaves cells within a repeat", async () => {
    const { adapter, calls } = fakeAdapter({ onRun: writeOut });
    await bench(adapter);
    expect(calls).toEqual([
      "run:baseline",
      "install",
      "run:with-skill",
      "run:baseline",
      "install",
      "run:with-skill",
    ]);
  });

  it("records one trial per task x repeat x cell, with run metadata", async () => {
    const { adapter } = fakeAdapter({ onRun: writeOut });
    const { store, runId, seen } = await bench(adapter);
    expect(seen).toHaveLength(4);
    expect(store.listTrials(runId)).toHaveLength(4);
    expect(store.getRun(runId)).toMatchObject({
      suite: "s",
      agent: "fake",
      agentVersion: "9.9",
      variants: [
        { label: "baseline" },
        {
          label: "with-skill",
          skillName: "demo",
          skillVersion: "1.0.0",
          skillDigest: "sha256:1",
        },
      ],
    });
    expect(seen.every((t) => t.passed && t.tokens === 50)).toBe(true);
  });

  it("fails a trial when any assertion fails and keeps the per-assertion detail", async () => {
    const { adapter } = fakeAdapter({ onRun: writeOut });
    const s = suite(
      "[{ type: file_exists, path: out.txt }, { type: file_exists, path: missing.txt }]",
    );
    const { seen } = await bench(adapter, s);
    expect(seen.every((t) => !t.passed)).toBe(true);
    expect(seen[0]?.assertions.map((a) => a.passed)).toEqual([true, false]);
  });

  it("evaluates skill_loaded against the with-skill cell only", async () => {
    const { adapter } = fakeAdapter();
    const { seen } = await bench(adapter, suite("[{ type: skill_loaded }]"));
    expect(seen.every((t) => t.passed)).toBe(true);
  });

  it("records a throwing adapter as an errored trial and keeps going", async () => {
    let n = 0;
    const { adapter } = fakeAdapter({
      onRun: async (ws) => {
        if (n++ === 0) throw new Error("spawn failed");
        return writeOut(ws, false);
      },
    });
    const { seen } = await bench(adapter);
    expect(seen).toHaveLength(4);
    expect(seen[0]).toMatchObject({
      status: "error",
      passed: false,
      error: "spawn failed",
      assertions: [],
    });
    expect(seen[1]?.passed).toBe(true);
  });

  it("does not evaluate assertions for timed-out trials, even if the files would pass", async () => {
    const { adapter } = fakeAdapter({
      onRun: async (ws) => {
        await writeOut(ws, false);
        return { status: "timeout", error: "timed out" };
      },
    });
    const { seen } = await bench(adapter);
    expect(
      seen.every((t) => t.status === "timeout" && !t.passed && t.assertions.length === 0),
    ).toBe(true);
  });

  it("seeds the workspace from fixtures and removes the workspace afterwards", async () => {
    const fx = join(tmp, "fx");
    await mkdir(fx);
    await writeFile(join(fx, "input.txt"), "data");
    let wsRoot = "";
    const { adapter } = fakeAdapter({
      onRun: async (ws) => {
        wsRoot = ws.root;
        return undefined;
      },
    });
    const s = suite("[{ type: file_exists, path: input.txt }]", "fixtures: ./fx");
    const { seen } = await bench(adapter, s);
    expect(seen.every((t) => t.passed)).toBe(true);
    expect(existsSync(wsRoot)).toBe(false);
  });

  it("writes transcript and raw output files under the run directory", async () => {
    const { adapter } = fakeAdapter({ onRun: writeOut });
    const { seen, runId } = await bench(adapter);
    const t = seen.find((x) => x.variant === "with-skill");
    expect(t?.transcriptPath).toMatch(new RegExp(`^runs/${runId}/with-skill__t1__1\\.jsonl$`));
    expect(existsSync(join(tmp, t?.transcriptPath ?? ""))).toBe(true);
    expect(existsSync(join(tmp, `runs/${runId}/baseline__t1__1.raw.txt`))).toBe(true);
  });

  it("refuses to run when the agent is unavailable", async () => {
    const { adapter } = fakeAdapter({ available: false });
    await expect(bench(adapter)).rejects.toThrow(/not available/);
  });

  describe("comparing two skill versions", () => {
    const older: Skill = { ...skill, dir: "/skill-old", version: "0.9.0", digest: "sha256:0" };

    it("installs each version into its own workspace and scopes skill_loaded to it", async () => {
      const { adapter } = fakeAdapter({ onRun: writeOut });
      const installed: (string | undefined)[] = [];
      const install = adapter.install.bind(adapter);
      adapter.install = async (s, ws) => {
        installed.push(s.version);
        await install(s, ws);
      };
      const { seen } = await bench(
        adapter,
        suite("[{ type: skill_loaded }]"),
        buildVariants(skill, older),
      );

      expect(installed).toEqual(["0.9.0", "1.0.0", "0.9.0", "1.0.0"]);
      expect(seen.map((t) => t.variant)).toEqual([
        "demo@0.9.0",
        "demo@1.0.0",
        "demo@0.9.0",
        "demo@1.0.0",
      ]);
      expect(seen.every((t) => t.passed)).toBe(true);
    });

    it("writes transcripts with filesystem-safe names for labels containing odd characters", async () => {
      const { adapter } = fakeAdapter({ onRun: writeOut });
      const variants: Variant[] = [
        { label: "a b/c", skill: older },
        { label: "d", skill },
      ];
      const { seen } = await bench(adapter, undefined, variants);
      expect(seen[0]?.transcriptPath).toMatch(/\/a_b_c__t1__1\.jsonl$/);
      expect(existsSync(join(tmp, seen[0]?.transcriptPath ?? ""))).toBe(true);
    });

    it("rejects fewer than two variants and duplicate labels before running anything", async () => {
      const { adapter, calls } = fakeAdapter();
      await expect(bench(adapter, undefined, [{ label: "baseline" }])).rejects.toThrow(
        /at least two/,
      );
      await expect(
        bench(adapter, undefined, [{ label: "x" }, { label: "x", skill }]),
      ).rejects.toThrow(/unique/);
      expect(calls).toEqual([]);
    });
  });
});
