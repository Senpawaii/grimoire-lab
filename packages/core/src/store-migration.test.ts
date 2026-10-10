import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResultStore } from "./store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "store-migration-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** The v2 layout: identical except assertion_results has no score column. */
function createV2(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, suite TEXT NOT NULL, agent TEXT NOT NULL,
      agent_version TEXT, model TEXT, started_at TEXT NOT NULL);
    CREATE TABLE variants (run_id INTEGER NOT NULL, idx INTEGER NOT NULL, label TEXT NOT NULL,
      skill_name TEXT, skill_version TEXT, skill_digest TEXT, PRIMARY KEY (run_id, idx));
    CREATE TABLE trials (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, variant TEXT NOT NULL,
      task_id TEXT NOT NULL, repeat_idx INTEGER NOT NULL, status TEXT NOT NULL, passed INTEGER NOT NULL,
      tokens INTEGER, cost_usd REAL, duration_ms INTEGER NOT NULL, final_message TEXT NOT NULL,
      error TEXT, transcript_path TEXT NOT NULL);
    CREATE TABLE assertion_results (trial_id INTEGER NOT NULL, idx INTEGER NOT NULL, type TEXT NOT NULL,
      passed INTEGER NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (trial_id, idx));
    INSERT INTO runs VALUES (1, 'old-suite', 'claude-code', NULL, NULL, '2026-10-03T00:00:00.000Z');
    INSERT INTO variants VALUES (1, 0, 'baseline', NULL, NULL, NULL);
    INSERT INTO trials VALUES (1, 1, 'baseline', 't', 1, 'completed', 1, NULL, NULL, 10, 'm', NULL, 'p');
    INSERT INTO assertion_results VALUES (1, 0, 'file_exists', 1, 'out.txt');
    PRAGMA user_version = 2;
  `);
  db.close();
}

describe("schema v2 to v3", () => {
  it("keeps existing runs readable (scores absent) and accepts new scored results", () => {
    const path = join(dir, "v2.db");
    createV2(path);

    const store = new ResultStore(path);
    expect(store.getRun(1)?.suite).toBe("old-suite");
    expect(store.listTrials(1)[0]?.assertions).toEqual([
      { type: "file_exists", passed: true, detail: "out.txt", score: undefined },
    ]);

    const id = store.createRun({ suite: "new", agent: "a", variants: [{ label: "baseline" }] });
    store.addTrial(id, {
      variant: "baseline",
      taskId: "t",
      repeatIdx: 1,
      status: "completed",
      passed: true,
      durationMs: 1,
      finalMessage: "",
      transcriptPath: "p",
      assertions: [{ type: "judge", passed: true, detail: "ok", score: 4 }],
    });
    expect(store.listTrials(id)[0]?.assertions[0]?.score).toBe(4);
    store.close();
  });

  it("is idempotent: reopening a migrated database does not fail", () => {
    const path = join(dir, "v2.db");
    createV2(path);
    new ResultStore(path).close();
    expect(() => new ResultStore(path).close()).not.toThrow();
  });
});
