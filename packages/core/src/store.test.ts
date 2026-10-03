import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResultStore, type RunMeta, type TrialRecord } from "./store.js";

const meta: RunMeta = {
  suite: "s",
  agent: "claude-code",
  agentVersion: "2.1.0",
  model: "haiku",
  variants: [
    { label: "baseline" },
    { label: "demo@1.0.0", skillName: "demo", skillVersion: "1.0.0", skillDigest: "sha256:abc" },
  ],
};

const trial = (over: Partial<TrialRecord> = {}): TrialRecord => ({
  variant: "demo@1.0.0",
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
  it("round-trips a run with its variants in order, trials and assertion results", () => {
    const store = new ResultStore(":memory:");
    const id = store.createRun(meta);
    store.addTrial(id, trial());
    store.addTrial(
      id,
      trial({
        variant: "baseline",
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
      variant: "baseline",
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
    const second = store.createRun({ ...meta, suite: "second" });
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

describe("ResultStore on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "store-test-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("persists across reopen", () => {
    const path = join(dir, "nested", "results.db");
    const first = new ResultStore(path);
    const id = first.createRun(meta);
    first.close();
    const second = new ResultStore(path);
    expect(second.getRun(id)?.suite).toBe("s");
    second.close();
  });

  it("refuses a v1 database instead of corrupting or misreading it", () => {
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY, skill_name TEXT)");
    old.close();
    expect(() => new ResultStore(path)).toThrow(/v1 results schema/);
  });

  it("refuses a database written by a newer schema", () => {
    const path = join(dir, "new.db");
    const future = new DatabaseSync(path);
    future.exec("PRAGMA user_version = 99");
    future.close();
    expect(() => new ResultStore(path)).toThrow(/newer grimoire/);
  });
});
