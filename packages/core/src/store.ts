import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssertionResult } from "./assertions.js";

export type Cell = "baseline" | "with-skill";

export interface RunMeta {
  suite: string;
  skillName: string;
  skillVersion?: string;
  skillDigest: string;
  agent: string;
  agentVersion?: string;
  model?: string;
}

export interface RunRecord extends RunMeta {
  id: number;
  startedAt: string;
}

export interface TrialRecord {
  cell: Cell;
  taskId: string;
  repeatIdx: number;
  status: "completed" | "timeout" | "error";
  passed: boolean;
  tokens?: number;
  costUsd?: number;
  durationMs: number;
  finalMessage: string;
  error?: string;
  /** Relative to the output directory. */
  transcriptPath: string;
  assertions: AssertionResult[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_version TEXT,
  skill_digest TEXT NOT NULL,
  agent TEXT NOT NULL,
  agent_version TEXT,
  model TEXT,
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  cell TEXT NOT NULL,
  task_id TEXT NOT NULL,
  repeat_idx INTEGER NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL,
  tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER NOT NULL,
  final_message TEXT NOT NULL,
  error TEXT,
  transcript_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assertion_results (
  trial_id INTEGER NOT NULL REFERENCES trials(id),
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,
  passed INTEGER NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (trial_id, idx)
);
`;

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export class ResultStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  createRun(meta: RunMeta): number {
    const r = this.db
      .prepare(
        `INSERT INTO runs (suite, skill_name, skill_version, skill_digest, agent, agent_version, model, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.suite,
        meta.skillName,
        meta.skillVersion ?? null,
        meta.skillDigest,
        meta.agent,
        meta.agentVersion ?? null,
        meta.model ?? null,
        new Date().toISOString(),
      );
    return Number(r.lastInsertRowid);
  }

  addTrial(runId: number, t: TrialRecord): void {
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          `INSERT INTO trials (run_id, cell, task_id, repeat_idx, status, passed, tokens, cost_usd,
             duration_ms, final_message, error, transcript_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          t.cell,
          t.taskId,
          t.repeatIdx,
          t.status,
          t.passed ? 1 : 0,
          t.tokens ?? null,
          t.costUsd ?? null,
          t.durationMs,
          t.finalMessage,
          t.error ?? null,
          t.transcriptPath,
        );
      const trialId = Number(r.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT INTO assertion_results (trial_id, idx, type, passed, detail) VALUES (?, ?, ?, ?, ?)",
      );
      t.assertions.forEach((a, i) => {
        ins.run(trialId, i, a.type, a.passed ? 1 : 0, a.detail);
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `undefined` selects the most recent run. */
  getRun(id?: number): RunRecord | undefined {
    const row = (
      id === undefined
        ? this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get()
        : this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id)
    ) as Row | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      suite: String(row.suite),
      skillName: String(row.skill_name),
      skillVersion: row.skill_version === null ? undefined : String(row.skill_version),
      skillDigest: String(row.skill_digest),
      agent: String(row.agent),
      agentVersion: row.agent_version === null ? undefined : String(row.agent_version),
      model: row.model === null ? undefined : String(row.model),
      startedAt: String(row.started_at),
    };
  }

  listTrials(runId: number): TrialRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM trials WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    const assertionStmt = this.db.prepare(
      "SELECT * FROM assertion_results WHERE trial_id = ? ORDER BY idx",
    );
    return rows.map((r) => ({
      cell: String(r.cell) as Cell,
      taskId: String(r.task_id),
      repeatIdx: Number(r.repeat_idx),
      status: String(r.status) as TrialRecord["status"],
      passed: r.passed === 1,
      tokens: r.tokens === null ? undefined : Number(r.tokens),
      costUsd: r.cost_usd === null ? undefined : Number(r.cost_usd),
      durationMs: Number(r.duration_ms),
      finalMessage: String(r.final_message),
      error: r.error === null ? undefined : String(r.error),
      transcriptPath: String(r.transcript_path),
      assertions: (assertionStmt.all(r.id as number) as Row[]).map((a) => ({
        type: String(a.type) as AssertionResult["type"],
        passed: a.passed === 1,
        detail: String(a.detail),
      })),
    }));
  }

  close(): void {
    this.db.close();
  }
}
