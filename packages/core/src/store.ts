import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssertionResult } from "./assertions.js";
import { type BenchResult, buildBenchResult } from "./result.js";

/**
 * v1 stored a single skill per run and had no `variants` table (unsupported, refused).
 * v2 lacked `assertion_results.score`; it is migrated in place.
 * v3 lacked `runs.suite_digest`/`suite_task_ids`/`repeat` and `trials.infra_error`; migrated in
 * place (old rows read back with those fields absent).
 * This number is internal and independent of the BenchResult `schemaVersion`.
 */
const SCHEMA_VERSION = 4;

/** One arm of a comparison: the baseline (no skill) or a specific skill version. */
export interface VariantMeta {
  label: string;
  /** Absent for the baseline. */
  skillName?: string;
  skillVersion?: string;
  skillDigest?: string;
}

export interface RunMeta {
  suite: string;
  agent: string;
  agentVersion?: string;
  model?: string;
  /** `digestSuite(suite)`; needed to read the run back as a BenchResult. */
  suiteDigest?: string;
  /** Task ids in suite order; needed to read the run back as a BenchResult. */
  taskIds?: string[];
  /** Repeats per task actually requested. */
  repeat?: number;
  /** In run order; the first variant is also first in reports. */
  variants: VariantMeta[];
}

export interface RunRecord extends RunMeta {
  id: number;
  startedAt: string;
}

export interface TrialRecord {
  variant: string;
  taskId: string;
  repeatIdx: number;
  status: "completed" | "timeout" | "error";
  passed: boolean;
  tokens?: number;
  costUsd?: number;
  durationMs: number;
  finalMessage: string;
  error?: string;
  /**
   * The harness could not measure the skill (adapter crash, rate limit, failed judge call), as
   * opposed to the skill failing. Absent on rows written before schema v4; readers then fall
   * back to `status === "error"`.
   */
  infraError?: boolean;
  /** Relative to the output directory. */
  transcriptPath: string;
  assertions: AssertionResult[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite TEXT NOT NULL,
  agent TEXT NOT NULL,
  agent_version TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  suite_digest TEXT,
  suite_task_ids TEXT,
  repeat INTEGER
);
CREATE TABLE IF NOT EXISTS variants (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  idx INTEGER NOT NULL,
  label TEXT NOT NULL,
  skill_name TEXT,
  skill_version TEXT,
  skill_digest TEXT,
  PRIMARY KEY (run_id, idx)
);
CREATE TABLE IF NOT EXISTS trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  variant TEXT NOT NULL,
  task_id TEXT NOT NULL,
  repeat_idx INTEGER NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL,
  tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER NOT NULL,
  final_message TEXT NOT NULL,
  error TEXT,
  transcript_path TEXT NOT NULL,
  infra_error INTEGER
);
CREATE TABLE IF NOT EXISTS assertion_results (
  trial_id INTEGER NOT NULL REFERENCES trials(id),
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,
  passed INTEGER NOT NULL,
  detail TEXT NOT NULL,
  score REAL,
  PRIMARY KEY (trial_id, idx)
);
`;

type Row = Record<string, string | number | bigint | null | Uint8Array>;

const optional = (v: Row[string] | undefined) =>
  v === null || v === undefined ? undefined : String(v);

export class ResultStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    try {
      this.migrate(path);
    } catch (err) {
      this.db.close(); // an open handle would keep the file locked (EBUSY on Windows)
      throw err;
    }
  }

  private migrate(path: string): void {
    const row = this.db.prepare("PRAGMA user_version").get() as Row;
    const version = Number(row.user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `${path} was written by a newer grimoire (schema ${version}); upgrade grimoire`,
      );
    }
    if (version === 0) {
      const old = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runs'").get();
      if (old) {
        throw new Error(
          `${path} uses the v1 results schema, which this version cannot read. Delete it to start fresh.`,
        );
      }
    }
    if (version === 2) this.db.exec("ALTER TABLE assertion_results ADD COLUMN score REAL");
    if (version >= 2 && version < 4) {
      this.db.exec("ALTER TABLE runs ADD COLUMN suite_digest TEXT");
      this.db.exec("ALTER TABLE runs ADD COLUMN suite_task_ids TEXT");
      this.db.exec("ALTER TABLE runs ADD COLUMN repeat INTEGER");
      this.db.exec("ALTER TABLE trials ADD COLUMN infra_error INTEGER");
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  createRun(meta: RunMeta): number {
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          "INSERT INTO runs (suite, agent, agent_version, model, started_at, suite_digest, suite_task_ids, repeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          meta.suite,
          meta.agent,
          meta.agentVersion ?? null,
          meta.model ?? null,
          new Date().toISOString(),
          meta.suiteDigest ?? null,
          meta.taskIds ? JSON.stringify(meta.taskIds) : null,
          meta.repeat ?? null,
        );
      const runId = Number(r.lastInsertRowid);
      const ins = this.db.prepare(
        `INSERT INTO variants (run_id, idx, label, skill_name, skill_version, skill_digest)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      meta.variants.forEach((v, i) => {
        ins.run(
          runId,
          i,
          v.label,
          v.skillName ?? null,
          v.skillVersion ?? null,
          v.skillDigest ?? null,
        );
      });
      this.db.exec("COMMIT");
      return runId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  addTrial(runId: number, t: TrialRecord): void {
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          `INSERT INTO trials (run_id, variant, task_id, repeat_idx, status, passed, tokens, cost_usd,
             duration_ms, final_message, error, transcript_path, infra_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          t.variant,
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
          t.infraError === undefined ? null : t.infraError ? 1 : 0,
        );
      const trialId = Number(r.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT INTO assertion_results (trial_id, idx, type, passed, detail, score) VALUES (?, ?, ?, ?, ?, ?)",
      );
      t.assertions.forEach((a, i) => {
        ins.run(trialId, i, a.type, a.passed ? 1 : 0, a.detail, a.score ?? null);
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
    const variants = (
      this.db
        .prepare("SELECT * FROM variants WHERE run_id = ? ORDER BY idx")
        .all(row.id as number) as Row[]
    ).map((v) => ({
      label: String(v.label),
      skillName: optional(v.skill_name),
      skillVersion: optional(v.skill_version),
      skillDigest: optional(v.skill_digest),
    }));
    const taskIds = optional(row.suite_task_ids);
    return {
      id: Number(row.id),
      suite: String(row.suite),
      agent: String(row.agent),
      agentVersion: optional(row.agent_version),
      model: optional(row.model),
      suiteDigest: optional(row.suite_digest),
      taskIds: taskIds === undefined ? undefined : (JSON.parse(taskIds) as string[]),
      repeat: row.repeat === null || row.repeat === undefined ? undefined : Number(row.repeat),
      startedAt: String(row.started_at),
      variants,
    };
  }

  /**
   * A stored run as a self-contained, JSON-serializable `BenchResult`; `undefined` if there is no
   * such run. Throws for runs written before schema v4: they never recorded a suite digest, so
   * they cannot be compared safely (read them with `getRun`/`listTrials`).
   */
  getResult(id: number | string): BenchResult | undefined {
    const n = typeof id === "string" ? Number(id) : id;
    if (!Number.isInteger(n)) return undefined;
    const run = this.getRun(n);
    return run && this.toResult(run);
  }

  /** The most recent run as a `BenchResult`; same caveats as `getResult`. */
  latestResult(): BenchResult | undefined {
    const run = this.getRun();
    return run && this.toResult(run);
  }

  private toResult(run: RunRecord): BenchResult {
    if (run.suiteDigest === undefined || run.taskIds === undefined) {
      throw new Error(
        `Run ${run.id} was recorded before suite digests were stored, so it cannot be read as a BenchResult`,
      );
    }
    return buildBenchResult(run, this.listTrials(run.id), {
      suite: { digest: run.suiteDigest, taskIds: run.taskIds },
    });
  }

  listTrials(runId: number): TrialRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM trials WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    const assertionStmt = this.db.prepare(
      "SELECT * FROM assertion_results WHERE trial_id = ? ORDER BY idx",
    );
    return rows.map((r) => ({
      variant: String(r.variant),
      taskId: String(r.task_id),
      repeatIdx: Number(r.repeat_idx),
      status: String(r.status) as TrialRecord["status"],
      passed: r.passed === 1,
      tokens: r.tokens === null ? undefined : Number(r.tokens),
      costUsd: r.cost_usd === null ? undefined : Number(r.cost_usd),
      durationMs: Number(r.duration_ms),
      finalMessage: String(r.final_message),
      error: optional(r.error),
      transcriptPath: String(r.transcript_path),
      infraError: r.infra_error === null ? undefined : r.infra_error === 1,
      assertions: (assertionStmt.all(r.id as number) as Row[]).map((a) => ({
        type: String(a.type) as AssertionResult["type"],
        passed: a.passed === 1,
        detail: String(a.detail),
        score: a.score === null ? undefined : Number(a.score),
      })),
    }));
  }

  close(): void {
    this.db.close();
  }
}
