import { existsSync } from "node:fs";
import { copyFile, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { AgentAdapter, RunResult, Skill, TranscriptEvent, Usage } from "@grimoire/core";
import { execa } from "execa";

const NOT_PART_OF_SKILL: Record<string, true> = { "grimoire.bench.yaml": true, fixtures: true };

interface ParsedOutput {
  transcript: TranscriptEvent[];
  finalMessage: string;
  usage?: Usage;
  /** Undefined when the stream had no result event. */
  resultError?: string | null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Parses `claude -p --output-format stream-json --verbose` output. Unknown events are ignored. */
export function parseStreamJson(stdout: string): ParsedOutput {
  const out: ParsedOutput = { transcript: [], finalMessage: "" };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(ev)) continue;

    if (ev.type === "assistant" && isObj(ev.message) && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (!isObj(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          out.transcript.push({ type: "message", role: "assistant", text: block.text });
        } else if (block.type === "tool_use") {
          const name = String(block.name);
          out.transcript.push({
            type: "tool_call",
            id: String(block.id),
            name,
            input: block.input,
          });
          if (name === "Skill" && isObj(block.input) && typeof block.input.skill === "string") {
            out.transcript.push({ type: "skill_loaded", skill: block.input.skill });
          }
        }
      }
    } else if (ev.type === "user" && isObj(ev.message) && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (isObj(block) && block.type === "tool_result") {
          out.transcript.push({
            type: "tool_result",
            id: String(block.tool_use_id),
            content: toolResultText(block.content),
            isError: block.is_error === true,
          });
        }
      }
    } else if (ev.type === "result") {
      out.finalMessage = typeof ev.result === "string" ? ev.result : "";
      out.resultError = ev.is_error === true ? out.finalMessage || String(ev.subtype) : null;
      if (isObj(ev.usage)) {
        const u = ev.usage;
        const n = (k: string) => (typeof u[k] === "number" ? u[k] : 0);
        out.usage = {
          tokens:
            n("input_tokens") +
            n("cache_creation_input_tokens") +
            n("cache_read_input_tokens") +
            n("output_tokens"),
          costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
        };
      }
    }
  }
  return out;
}

/**
 * The agent runs with CLAUDE_CONFIG_DIR pointed at a scratch dir, so the user's own skills,
 * settings and hooks cannot leak into the baseline. Only the login credentials are copied in.
 */
async function isolatedEnv(configDir: string): Promise<Record<string, string>> {
  await mkdir(configDir, { recursive: true });
  if (process.env.ANTHROPIC_API_KEY) return { CLAUDE_CONFIG_DIR: configDir };
  const sourceDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const creds = join(sourceDir, ".credentials.json");
  if (!existsSync(creds)) {
    throw new Error(
      `Cannot isolate the Claude config: no ${creds} and ANTHROPIC_API_KEY is not set. ` +
        "Log in with `claude` (credentials file) or set ANTHROPIC_API_KEY.",
    );
  }
  await copyFile(creds, join(configDir, ".credentials.json"));
  return { CLAUDE_CONFIG_DIR: configDir };
}

export const claudeCode: AgentAdapter = {
  id: "claude-code",

  async detect() {
    const r = await execa("claude", ["--version"], { reject: false });
    if (r.failed || r.exitCode !== 0) return { available: false };
    return { available: true, version: String(r.stdout).trim().split(/\s+/)[0] };
  },

  async install(skill: Skill, ws) {
    const dest = join(ws.dir, ".claude", "skills", skill.name);
    await cp(skill.dir, dest, {
      recursive: true,
      filter: (src) => {
        const rel = relative(skill.dir, src);
        return !NOT_PART_OF_SKILL[rel.split(sep)[0] ?? ""];
      },
    });
  },

  async run(req, ws): Promise<RunResult> {
    const started = Date.now();
    const finish = (r: Omit<RunResult, "durationMs">): RunResult => ({
      ...r,
      durationMs: Date.now() - started,
    });

    const env = await isolatedEnv(join(ws.root, "claude-config"));
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      ...(req.model ? ["--model", req.model] : []),
    ];
    // The prompt goes over stdin: no shell quoting or Windows command-line length limits.
    const r = await execa("claude", args, {
      cwd: ws.dir,
      env,
      input: req.prompt,
      timeout: req.timeoutMs,
      reject: false,
    });
    const rawOutput = String(r.stdout ?? "");
    const parsed = parseStreamJson(rawOutput);

    if (r.timedOut) {
      return finish({
        status: "timeout",
        ...parsed,
        rawOutput,
        error: `timed out after ${req.timeoutMs}ms`,
      });
    }
    if (parsed.resultError === undefined) {
      return finish({
        status: "error",
        ...parsed,
        rawOutput,
        error: `claude exited ${r.exitCode ?? "abnormally"} without a result: ${String(r.stderr ?? "").slice(0, 500)}`,
      });
    }
    if (parsed.resultError !== null) {
      return finish({ status: "error", ...parsed, rawOutput, error: parsed.resultError });
    }
    return finish({ status: "completed", ...parsed, rawOutput });
  },
};
