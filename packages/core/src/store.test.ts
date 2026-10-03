import { describe, expect, it } from "vitest";
import { ResultStore, type RunMeta, type TrialRecord } from "./store.js";

const meta: RunMeta = {
  suite: "s",
  skillName: "demo",
  skillVersion: "1.0.0",
  skillDigest: "sha256:abc",
  agent: "claude-code",
  agentVersion: "2.1.0",
  model: "haiku",
};

const trial = (over: Partial<TrialRecord> = {}): TrialRecord => ({
  cell: "with-skill",
  taskId: "t1",
  repeatIdx: 1,
  status: "completed",
  passed: true,
  tokens: 123,
  costUsd: 0.01,
  durationMs: 4000,
  finalMessage: "done",
  transcriptPath: "runs/1/x.jsonl",
  assertions: [
    { type: "file_exists", passed: true, detail: "out.txt" },
    { type: "skill_loaded", passed: false, detail: "never" },
  ],
  ...over,
});

describe("ResultStore", () => {
  it("round-trips a run with its trials and assertion results", () => {
    const store = new ResultStore(":memory:");
    const id = store.createRun(meta);
    store.addTrial(id, trial());
    store.addTrial(
      id,
      trial({
        cell: "baseline",
        passed: false,
        tokens: undefined,
        costUsd: undefined,
        error: "boom",
        status: "error",
        assertions: [],
      }),
    );

    expect(store.getRun(id)).toMatchObject({ id, ...meta });
    const trials = store.listTrials(id);
    expect(trials).toHaveLength(2);
    expect(trials[0]).toEqual(trial());
    expect(trials[1]).toMatchObject({
      cell: "baseline",
      status: "error",
      error: "boom",
      tokens: undefined,
    });
    store.close();
  });

  it("returns the newest run when no id is given, and undefined for unknown ids", () => {
    const store = new ResultStore(":memory:");
    expect(store.getRun()).toBeUndefined();
    store.createRun(meta);
    const second = store.createRun({ ...meta, skillVersion: "1.1.0" });
    expect(store.getRun()?.id).toBe(second);
    expect(store.getRun(999)).toBeUndefined();
    store.close();
  });

  it("keeps trials of different runs separate", () => {
    const store = new ResultStore(":memory:");
    const a = store.createRun(meta);
    const b = store.createRun(meta);
    store.addTrial(a, trial());
    expect(store.listTrials(a)).toHaveLength(1);
    expect(store.listTrials(b)).toHaveLength(0);
    store.close();
  });

  it("rejects trials for a run that does not exist", () => {
    const store = new ResultStore(":memory:");
    expect(() => store.addTrial(42, trial())).toThrow();
    store.close();
  });
});
