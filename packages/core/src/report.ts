import type { ArmResult, BenchResult, TrialResult } from "./result.js";

export interface VariantSummary {
  variant: string;
  trials: number;
  passes: number;
  meanTokens?: number;
  meanDurationMs: number;
  meanCostUsd?: number;
  /** Mean 1-5 judge score over trials that were judged. */
  meanJudgeScore?: number;
}

export function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * One summary per arm, in run order. Errored and timed-out trials count as failures; means skip
 * trials that lack the metric. Arms with no trials are skipped.
 */
export function summarize(result: BenchResult): VariantSummary[] {
  return result.arms
    .filter((arm) => arm.score.trials > 0)
    .map(({ label, score }) => ({
      variant: label,
      trials: score.trials,
      passes: score.passes,
      meanTokens: score.meanTokens,
      meanDurationMs: score.meanDurationMs,
      meanCostUsd: score.meanCostUsd,
      meanJudgeScore: score.meanJudgeScore,
    }));
}

const mark = (t: TrialResult) => (t.passed ? "✓" : t.status === "completed" ? "✗" : "!");

/** One progress line for a trial of the arm labeled `arm`. */
export function formatTrialLine(t: TrialResult, arm: string): string {
  const failed = t.assertions.filter((a) => !a.passed).map((a) => a.detail);
  const why =
    t.status !== "completed" ? `${t.status}${t.error ? `: ${t.error}` : ""}` : failed.join("; ");
  return `[${arm}] ${t.taskId} #${t.repeatIdx} ${mark(t)}${why ? `  ${why}` : ""}`;
}

const fmtTokens = (n?: number) =>
  n === undefined ? "-" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
const fmtSeconds = (ms: number) => `${Math.round(ms / 1000)}s`;
const fmtCost = (n?: number) => (n === undefined ? "-" : `$${n.toFixed(3)}`);

function pad(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

function describeArm(arm: ArmResult): string {
  if (!arm.skill) return `  ${arm.label}: no skill`;
  const { name, version, digest } = arm.skill;
  const ref = `${name}${version ? `@${version}` : ""}`;
  const short = digest.slice(0, 19);
  return `  ${arm.label}: ${ref === arm.label ? short : `${ref} (${short})`}`;
}

export function formatReport(result: BenchResult): string {
  const agent = result.arms[0]?.agent;
  const lines = [
    `suite ${result.suite.name} · agent ${agent?.id ?? ""}${agent?.version ? ` ${agent.version}` : ""}${agent?.model ? ` · model ${agent.model}` : ""}`,
    `run ${result.id} · ${result.startedAt}`,
    ...result.arms.map(describeArm),
    "",
  ];

  const taskIds = [...new Set(result.arms.flatMap((a) => a.tasks.map((t) => t.taskId)))];
  const summaries = summarize(result);
  const perTask = taskIds.flatMap((id) =>
    result.arms
      .filter((arm) => arm.score.trials > 0)
      .map((arm) => [
        `[${arm.label}]`,
        id,
        [...(arm.tasks.find((t) => t.taskId === id)?.trials ?? [])]
          .sort((a, b) => a.repeatIdx - b.repeatIdx)
          .map(mark)
          .join(" "),
      ]),
  );
  lines.push(...pad(perTask), "");

  const showJudge = summaries.some((s) => s.meanJudgeScore !== undefined);
  const table = [
    ["", "pass rate", "mean tokens", "mean time", "mean cost", ...(showJudge ? ["judge"] : [])],
    ...summaries.map((s) => [
      s.variant,
      `${s.passes}/${s.trials}`,
      fmtTokens(s.meanTokens),
      fmtSeconds(s.meanDurationMs),
      fmtCost(s.meanCostUsd),
      ...(showJudge
        ? [s.meanJudgeScore === undefined ? "-" : `${s.meanJudgeScore.toFixed(1)}/5`]
        : []),
    ]),
  ];
  lines.push(...pad(table));
  return lines.join("\n");
}
