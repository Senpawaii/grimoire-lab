import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, normalize, resolve } from "node:path";
import type { AgentAdapter, RunResult, Skill } from "@grimoire/core";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { copySkill } from "./skill-files.js";

/** Replaced in every `args` element by the task prompt (argv replacement, never shell-interpolated). */
export const PROMPT_PLACEHOLDER = "{prompt}";

const DEFAULT_ID = "command";
const DEFAULT_MAX_OUTPUT_CHARS = 10_000_000;
const DETECT_TIMEOUT_MS = 30_000;
const insideWorkspace = (dir: string): boolean => {
  const first = normalize(dir).split(/[\\/]/)[0];
  return !isAbsolute(dir) && first !== "..";
};

export const CommandAdapterConfigSchema = z
  .strictObject({
    /** Adapter id stored in results (`BenchResult.agent`). Default "command". */
    id: z.string().min(1).optional(),
    /** Executable, spawned directly (no shell). Resolved on PATH like any spawn. */
    command: z.string().min(1),
    /** Arguments; `{prompt}` is replaced by the prompt inside every element it appears in. */
    args: z.array(z.string()).default([]),
    /** How the prompt reaches the agent: in `args` (default) or on stdin. */
    promptVia: z.enum(["arg", "stdin"]).default("arg"),
    /** Added to (and overriding) the environment inherited from the grimoire process. */
    env: z.record(z.string(), z.string()).default({}),
    /** Workspace-relative directory the skill is copied into, e.g. `.codex/skills`. */
    skillDir: z
      .string()
      .min(1)
      .refine(insideWorkspace, "must be a relative path inside the workspace")
      .optional(),
    /** Availability probe, e.g. `codex --version` or `["codex", "--version"]` (whitespace-split). */
    detect: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** When set and a model is requested, `[modelArg, model]` is appended to the arguments. */
    modelArg: z.string().min(1).optional(),
    /** Stdout/stderr size cap in characters; exceeding it kills the agent (an agent error). */
    maxOutputChars: z.number().int().positive().default(DEFAULT_MAX_OUTPUT_CHARS),
  })
  .superRefine((c, ctx) => {
    const used = c.args.some((a) => a.includes(PROMPT_PLACEHOLDER));
    if (c.promptVia === "arg" && !used) {
      ctx.addIssue({
        code: "custom",
        path: ["args"],
        message: `promptVia "arg" needs ${PROMPT_PLACEHOLDER} in at least one argument (or set promptVia: stdin)`,
      });
    }
    if (c.promptVia === "stdin" && used) {
      ctx.addIssue({
        code: "custom",
        path: ["args"],
        message: `${PROMPT_PLACEHOLDER} cannot be used with promptVia "stdin"`,
      });
    }
  });

export type CommandAdapterConfig = z.input<typeof CommandAdapterConfigSchema>;

/** Validates a command-adapter config; the error names every offending field. */
export function parseCommandConfig(
  config: unknown,
  origin = "agent config",
): z.output<typeof CommandAdapterConfigSchema> {
  const parsed = CommandAdapterConfigSchema.safeParse(config);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`Invalid ${origin}: ${issues}`);
}

/** Reads and validates a command-adapter config from a `.json`, `.yaml` or `.yml` file. */
export async function loadCommandConfig(
  file: string,
): Promise<z.output<typeof CommandAdapterConfigSchema>> {
  const text = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    throw new Error(`Cannot read agent config ${file}: ${err.message}`);
  });
  let data: unknown;
  try {
    data = extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new Error(
      `Cannot parse agent config ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseCommandConfig(data, `agent config ${file}`);
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Whether `command` resolves to an executable file, the way a no-shell spawn would find it. */
function commandExists(command: string, env: Record<string, string>, cwd: string): boolean {
  const win = process.platform === "win32";
  const lookup = (name: string): string | undefined =>
    win
      ? Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
      : env[name];
  const exts = win
    ? ["", ...(lookup("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const dirs = /[\\/]/.test(command)
    ? [resolve(cwd)]
    : (lookup("PATH") ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) =>
    exts.some((ext) => {
      const candidate = resolve(dir, command + ext);
      if (!isFile(candidate)) return false;
      if (win) return true;
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Runs any CLI as the agent. The prompt is delivered by argv replacement (`{prompt}`) or stdin and
 * is never interpolated into a shell command. See README "Other agents (command adapter)".
 */
export function createCommandAdapter(config: CommandAdapterConfig): AgentAdapter {
  const cfg = parseCommandConfig(config);
  const id = cfg.id ?? DEFAULT_ID;
  const envOf = (): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    ...cfg.env,
  });

  return {
    id,

    async detect() {
      if (cfg.detect === undefined) return { available: true };
      const argv = typeof cfg.detect === "string" ? cfg.detect.trim().split(/\s+/) : cfg.detect;
      const [file = "", ...rest] = argv;
      if (!commandExists(file, envOf(), process.cwd())) return { available: false };
      const r = await execa(file, rest, {
        env: cfg.env,
        stdin: "ignore",
        timeout: DETECT_TIMEOUT_MS,
        reject: false,
      });
      if (r.failed || r.exitCode !== 0) return { available: false };
      const version = `${r.stdout}\n${r.stderr}`
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      return { available: true, version };
    },

    async install(skill: Skill, ws) {
      // Without a skillDir the agent has no skill support: nothing is installed.
      if (cfg.skillDir === undefined) return;
      await copySkill(skill, join(ws.dir, cfg.skillDir, skill.name));
    },

    async run(req, ws): Promise<RunResult> {
      const started = Date.now();
      const finish = (r: Omit<RunResult, "durationMs">): RunResult => ({
        ...r,
        durationMs: Date.now() - started,
      });
      const infra = (error: string): RunResult =>
        finish({
          status: "error",
          errorKind: "infrastructure",
          transcript: [],
          finalMessage: "",
          rawOutput: "",
          error,
        });

      if (!commandExists(cfg.command, envOf(), ws.dir)) {
        return infra(`command "${cfg.command}" was not found (is it installed and on PATH?)`);
      }

      const args = cfg.args.map((a) => a.split(PROMPT_PLACEHOLDER).join(req.prompt));
      // model is ignored unless the config says how to pass it; tools is never passed.
      if (req.model !== undefined && cfg.modelArg !== undefined) args.push(cfg.modelArg, req.model);

      const subprocess = execa(cfg.command, args, {
        cwd: ws.dir,
        env: cfg.env,
        ...(cfg.promptVia === "stdin" ? { input: req.prompt } : { stdin: "ignore" as const }),
        timeout: req.timeoutMs,
        maxBuffer: cfg.maxOutputChars,
        reject: false,
      });
      // execa's maxBuffer only truncates what it keeps; it leaves a runaway agent running.
      let capped = false;
      for (const stream of [subprocess.stdout, subprocess.stderr]) {
        let seen = 0;
        stream?.on("data", (chunk: Buffer | string) => {
          seen += chunk.length;
          if (seen > cfg.maxOutputChars && !capped) {
            capped = true;
            subprocess.kill();
          }
        });
      }
      const r = await subprocess;
      const stdout = String(r.stdout ?? "");
      const stderrHead = String(r.stderr ?? "")
        .trim()
        .slice(0, 500);
      const out = {
        transcript: [{ type: "message" as const, role: "assistant" as const, text: stdout }],
        finalMessage: stdout.trim(),
        rawOutput: stdout,
      };
      const agentError = (error: string) =>
        finish({ status: "error", errorKind: "agent", ...out, error });

      if (r.timedOut) {
        return finish({
          status: "timeout",
          ...out,
          error: `timed out after ${req.timeoutMs}ms`,
        });
      }
      if (capped || r.isMaxBuffer) {
        return agentError(`output exceeded ${cfg.maxOutputChars} characters; agent was stopped`);
      }
      if (r.exitCode === undefined && !r.isTerminated) {
        return infra(`could not run "${cfg.command}": ${r.shortMessage}`);
      }
      if (r.exitCode !== 0) {
        const how = r.exitCode === undefined ? "was killed by a signal" : `exited ${r.exitCode}`;
        return agentError(`${cfg.command} ${how}${stderrHead ? `: ${stderrHead}` : ""}`);
      }
      return finish({ status: "completed", ...out });
    },
  };
}
