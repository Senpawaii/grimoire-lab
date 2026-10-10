import { readFile, stat } from "node:fs/promises";
import { execa } from "execa";
import type { Assertion } from "./suite.js";
import type { RunResult, Skill, TranscriptEvent, Workspace } from "./types.js";
import { resolveInside } from "./workspace.js";

export interface AssertionContext {
  ws: Workspace;
  result: RunResult;
  /** Undefined in the baseline cell. */
  skill?: Skill;
}

export interface AssertionResult {
  /** "judge" is produced by the LLM judge, not by a suite assertion. */
  type: Assertion["type"] | "judge";
  passed: boolean;
  detail: string;
  /** 1-5, only for the judge. */
  score?: number;
}

const COMMAND_TIMEOUT_MS = 60_000;

function searchableText(events: TranscriptEvent[], tool?: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (tool !== undefined) {
      if (e.type === "tool_call" && e.name === tool) out.push(JSON.stringify(e.input));
    } else if (e.type === "message") out.push(e.text);
    else if (e.type === "tool_call") out.push(JSON.stringify(e.input));
    else if (e.type === "tool_result") out.push(e.content);
  }
  return out;
}

async function check(a: Assertion, ctx: AssertionContext): Promise<Omit<AssertionResult, "type">> {
  switch (a.type) {
    case "file_exists": {
      const p = resolveInside(ctx.ws.dir, a.path);
      const exists = await stat(p).then(
        () => true,
        () => false,
      );
      return { passed: exists, detail: exists ? a.path : `${a.path} does not exist` };
    }
    case "file_contains": {
      const p = resolveInside(ctx.ws.dir, a.path);
      const text = await readFile(p, "utf8").catch(() => undefined);
      if (text === undefined) return { passed: false, detail: `${a.path} does not exist` };
      const ok = new RegExp(a.regex).test(text);
      return {
        passed: ok,
        detail: ok ? `${a.path} matches /${a.regex}/` : `${a.path} has no match for /${a.regex}/`,
      };
    }
    case "command": {
      const r = await execa(a.run, {
        shell: true,
        cwd: ctx.ws.dir,
        reject: false,
        timeout: COMMAND_TIMEOUT_MS,
        all: true,
      });
      const ok = r.exitCode === a.exitCode;
      const tail = (r.all ?? "").toString().slice(-300);
      return {
        passed: ok,
        detail: ok
          ? `\`${a.run}\` exited ${a.exitCode}`
          : `\`${a.run}\` exited ${r.exitCode ?? "(no code)"}, wanted ${a.exitCode}: ${tail}`,
      };
    }
    case "transcript_contains": {
      const re = new RegExp(a.pattern);
      const ok = searchableText(ctx.result.transcript, a.tool).some((t) => re.test(t));
      const scope = a.tool ? `${a.tool} calls` : "transcript";
      return {
        passed: ok,
        detail: ok ? `${scope} match /${a.pattern}/` : `no ${scope} match /${a.pattern}/`,
      };
    }
    case "skill_loaded": {
      if (!ctx.skill) return { passed: true, detail: "skipped (no skill installed)" };
      const name = ctx.skill.name;
      const ok = ctx.result.transcript.some((e) => e.type === "skill_loaded" && e.skill === name);
      return {
        passed: ok,
        detail: ok ? `skill "${name}" was invoked` : `skill "${name}" was never invoked`,
      };
    }
    case "max": {
      const actual =
        a.metric === "durationMs"
          ? ctx.result.durationMs
          : a.metric === "tokens"
            ? ctx.result.usage?.tokens
            : ctx.result.usage?.costUsd;
      if (actual === undefined) return { passed: false, detail: `agent reported no ${a.metric}` };
      const ok = actual <= a.value;
      return { passed: ok, detail: `${a.metric} ${actual} ${ok ? "<=" : ">"} ${a.value}` };
    }
  }
}

/** Never throws: an assertion that cannot be evaluated fails with the reason. */
export async function evaluateAssertion(
  a: Assertion,
  ctx: AssertionContext,
): Promise<AssertionResult> {
  try {
    return { type: a.type, ...(await check(a, ctx)) };
  } catch (err) {
    return {
      type: a.type,
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
