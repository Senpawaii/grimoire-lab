import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, RunResult, Skill, TranscriptEvent, Usage } from "@grimoire/core";
import { execa } from "execa";
import { copySkill } from "./skill-files.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;

const SKILL_DIR = join(".omp", "skills");
const SKILL_URL = /^skill:\/\/([^/?#\s]+)/;
const KILL_GRACE_MS = 2_000;

export interface OmpParsedOutput {
  transcript: TranscriptEvent[];
  finalMessage: string;
  usage?: Usage;
  /** The stream reached `agent_end`. Without it omp did not run the agent (bad flag, unknown model). */
  ended: boolean;
  /** Provider-level failure of the last assistant message (rate limit, auth, overloaded). */
  providerError?: string;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (isObj(p) && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join("");
}

/**
 * Parses `omp -p --mode json` output (one JSON event per line). Uses `message_end` and
 * `tool_execution_*`, never `message_update`, which carries no full snapshot. Unknown events and
 * non-JSON lines are ignored.
 */
export function parseOmpJson(stdout: string): OmpParsedOutput {
  const out: OmpParsedOutput = { transcript: [], finalMessage: "", ended: false };
  let tokens = 0;
  let cost = 0;
  let sawCost = false;
  let sawUsage = false;
  let lastAssistant: Json | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObj(ev)) continue;

    if (ev.type === "agent_end") {
      out.ended = true;
    } else if (ev.type === "message_end" && isObj(ev.message)) {
      const m = ev.message;
      if (m.role !== "assistant") continue;
      lastAssistant = m;
      const text = contentText(m.content);
      if (text) out.transcript.push({ type: "message", role: "assistant", text });
      if (isObj(m.usage)) {
        if (typeof m.usage.totalTokens === "number") {
          tokens += m.usage.totalTokens;
          sawUsage = true;
        }
        if (isObj(m.usage.cost) && typeof m.usage.cost.total === "number") {
          cost += m.usage.cost.total;
          sawCost = true;
        }
      }
    } else if (ev.type === "tool_execution_start" && typeof ev.toolCallId === "string") {
      const name = typeof ev.toolName === "string" ? ev.toolName : "";
      out.transcript.push({ type: "tool_call", id: ev.toolCallId, name, input: ev.args });
      if (name === "read" && isObj(ev.args) && typeof ev.args.path === "string") {
        const skill = SKILL_URL.exec(ev.args.path)?.[1];
        if (skill) out.transcript.push({ type: "skill_loaded", skill });
      }
    } else if (ev.type === "tool_execution_end" && typeof ev.toolCallId === "string") {
      out.transcript.push({
        type: "tool_result",
        id: ev.toolCallId,
        content: isObj(ev.result) ? contentText(ev.result.content) : "",
        isError: ev.isError === true,
      });
    }
  }

  if (lastAssistant) {
    out.finalMessage = contentText(lastAssistant.content).trim();
    if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
      out.providerError =
        typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage
          ? lastAssistant.errorMessage
          : `the model request ended with stopReason "${String(lastAssistant.stopReason)}"`;
    }
  }
  if (sawUsage) out.usage = { tokens, ...(sawCost ? { costUsd: cost } : {}) };
  return out;
}

/** Kills `pid` and everything it started. A plain kill leaves tool subprocesses running, notably on Windows. */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execa("taskkill", ["/pid", String(pid), "/T", "/F"], { reject: false, stdin: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Names of the skills installed in the trial workspace; the arm's skill set. */
async function installedSkills(wsDir: string): Promise<string[]> {
  const dir = join(wsDir, SKILL_DIR);
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Runs `omp` headless. Isolation is part of the measurement: the baseline arm runs with
 * `--no-skills`, the skill arm with `--skills <installed>` so the user's own skills, rules and
 * extensions cannot reach either arm. Thinking effort is the `:level` suffix of the model selector
 * (`anthropic/claude-sonnet-5-5:high`), which keeps it in the recorded `agent.model`.
 */
export const omp: AgentAdapter = {
  id: "omp",

  async detect() {
    const r = await execa("omp", ["--version"], { reject: false, stdin: "ignore" });
    if (r.failed || r.exitCode !== 0) return { available: false };
    const version = String(r.stdout).trim().split(/\s+/).pop();
    return { available: true, ...(version ? { version: version.replace(/^omp\//, "") } : {}) };
  },

  async install(skill: Skill, ws) {
    await copySkill(skill, join(ws.dir, SKILL_DIR, skill.name));
  },

  async run(req, ws): Promise<RunResult> {
    const started = Date.now();
    const finish = (r: Omit<RunResult, "durationMs">): RunResult => ({
      ...r,
      durationMs: Date.now() - started,
    });
    const infra = (error: string, rawOutput = ""): RunResult =>
      finish({
        status: "error",
        errorKind: "infrastructure",
        transcript: [],
        finalMessage: "",
        rawOutput,
        error,
      });

    const skills = await installedSkills(ws.dir);
    const args = [
      "-p",
      "--no-session",
      "--mode",
      "json",
      "--approval-mode",
      "yolo",
      "--no-rules",
      "--no-extensions",
      ...(skills.length > 0 ? ["--skills", skills.join(",")] : ["--no-skills"]),
      ...(req.model ? ["--model", req.model] : []),
      ...(req.tools
        ? req.tools.length === 0
          ? ["--no-tools"]
          : ["--tools", req.tools.join(",")]
        : []),
    ];

    // The prompt goes over stdin: no shell quoting or Windows command-line length limits.
    // Timeout is handled here, not by execa, so the whole process tree is killed.
    const subprocess = execa("omp", args, {
      cwd: ws.dir,
      input: req.prompt,
      reject: false,
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (subprocess.pid !== undefined) void killTree(subprocess.pid);
    }, req.timeoutMs);
    // A tree that ignores the first kill must not hang the trial.
    const backstopTimer = setTimeout(
      () => subprocess.kill("SIGKILL"),
      req.timeoutMs + KILL_GRACE_MS,
    );
    const r = await subprocess;
    clearTimeout(timer);
    clearTimeout(backstopTimer);

    const rawOutput = String(r.stdout ?? "");
    const parsed = parseOmpJson(rawOutput);
    const { ended, providerError, ...out } = parsed;
    const stderrHead = String(r.stderr ?? "")
      .trim()
      .slice(0, 500);

    if (timedOut) {
      return finish({
        status: "timeout",
        ...out,
        rawOutput,
        error: `timed out after ${req.timeoutMs}ms`,
      });
    }
    if (r.exitCode === undefined && !r.isTerminated) {
      return infra(`could not run "omp": ${r.shortMessage}`);
    }
    if (!ended) {
      const how = r.exitCode === undefined ? "was killed by a signal" : `exited ${r.exitCode}`;
      const detail = (stderrHead || rawOutput.trim()).slice(0, 500);
      return infra(`omp ${how} without finishing a run${detail ? `: ${detail}` : ""}`, rawOutput);
    }
    if (providerError !== undefined) {
      return finish({
        status: "error",
        errorKind: "infrastructure",
        ...out,
        rawOutput,
        error: providerError,
      });
    }
    if (r.exitCode !== 0) {
      return finish({
        status: "error",
        errorKind: "agent",
        ...out,
        rawOutput,
        error: `omp exited ${r.exitCode}${stderrHead ? `: ${stderrHead}` : ""}`,
      });
    }
    return finish({ status: "completed", ...out, rawOutput });
  },
};
