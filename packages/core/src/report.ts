import type { RunRecord, TrialRecord } from "./store.js";

export interface VariantSummary {
  variant: string;
  trials: number;
  passes: number;
  meanTokens?: number;
  meanDurationMs: number;
  meanCostUsd?: number;
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * One summary per variant, in `order` (default: first appearance). Errored and timed-out trials
 * count as failures; means skip trials that lack the metric.
 */
export function summarize(
  trials: TrialRecord[],
  order: string[] = [...new Set(trials.map((t) => t.variant))],
): VariantSummary[] {
  return order
    .map((variant) => ({ variant, ts: trials.filter((t) => t.variant === variant) }))
    .filter(({ ts }) => ts.length > 0)
    .map(({ variant, ts }) => ({
      variant,
      trials: ts.length,
      passes: ts.filter((t) => t.passed).length,
      meanTokens: mean(ts.flatMap((t) => (t.tokens === undefined ? [] : [t.tokens]))),
      meanDurationMs: mean(ts.map((t) => t.durationMs)) ?? 0,
      meanCostUsd: mean(ts.flatMap((t) => (t.costUsd === undefined ? [] : [t.costUsd]))),
    }));
}

const mark = (t: TrialRecord) => (t.passed ? "✓" : t.status === "completed" ? "✗" : "!");

export function formatTrialLine(t: TrialRecord): string {
  const failed = t.assertions.filter((a) => !a.passed).map((a) => a.detail);
  const why =
    t.status !== "completed" ? `${t.status}${t.error ? `: ${t.error}` : ""}` : failed.join("; ");
  return `[${t.variant}] ${t.taskId} #${t.repeatIdx} ${mark(t)}${why ? `  ${why}` : ""}`;
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

export function formatReport(run: RunRecord, trials: TrialRecord[]): string {
  const lines = [
    `suite ${run.suite} · agent ${run.agent}${run.agentVersion ? ` ${run.agentVersion}` : ""}${run.model ? ` · model ${run.model}` : ""}`,
    `run ${run.id} · ${run.startedAt}`,
    ...run.variants.map((v) =>
      v.skillName
        ? `  ${v.label}: ${v.skillName}${v.skillVersion ? `@${v.skillVersion}` : ""} (${(v.skillDigest ?? "").slice(0, 19)})`
        : `  ${v.label}: no skill`,
    ),
    "",
  ];

  const taskIds = [...new Set(trials.map((t) => t.taskId))];
  const summaries = summarize(
    trials,
    run.variants.map((v) => v.label),
  );
  const perTask = taskIds.flatMap((id) =>
    summaries.map(({ variant }) => [
      `[${variant}]`,
      id,
      trials
        .filter((t) => t.taskId === id && t.variant === variant)
        .sort((a, b) => a.repeatIdx - b.repeatIdx)
        .map(mark)
        .join(" "),
    ]),
  );
  lines.push(...pad(perTask), "");

  const table = [
    ["", "pass rate", "mean tokens", "mean time", "mean cost"],
    ...summaries.map((s) => [
      s.variant,
      `${s.passes}/${s.trials}`,
      fmtTokens(s.meanTokens),
      fmtSeconds(s.meanDurationMs),
      fmtCost(s.meanCostUsd),
    ]),
  ];
  lines.push(...pad(table));
  return lines.join("\n");
}
