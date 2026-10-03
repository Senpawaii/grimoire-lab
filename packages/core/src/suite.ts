import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const Regex = z
  .string()
  .min(1)
  .refine((s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  }, "invalid regular expression");

export const Assertion = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("file_exists"), path: z.string().min(1) }),
  z.strictObject({ type: z.literal("file_contains"), path: z.string().min(1), regex: Regex }),
  z.strictObject({
    type: z.literal("command"),
    run: z.string().min(1),
    exitCode: z.number().int().default(0),
  }),
  z.strictObject({
    type: z.literal("transcript_contains"),
    /** Restrict to calls of this tool; omit to search all messages and tool calls. */
    tool: z.string().optional(),
    pattern: Regex,
  }),
  /** Passes if the agent invoked the skill. Skipped in the baseline cell. */
  z.strictObject({ type: z.literal("skill_loaded") }),
  z.strictObject({
    type: z.literal("max"),
    metric: z.enum(["tokens", "durationMs", "costUsd"]),
    value: z.number().positive(),
  }),
]);
export type Assertion = z.infer<typeof Assertion>;

/** An LLM scores the task result 1-5 against a rubric, in addition to the assertions. */
const JudgeSpec = z.strictObject({
  rubric: z.string().min(1),
  passScore: z.number().int().min(1).max(5).default(4),
  model: z.string().min(1).optional(),
  /** Shell commands run in the workspace; their output is shown to the judge. */
  commands: z.array(z.string().min(1)).default([]),
  /** Workspace-relative text files shown to the judge. */
  files: z.array(z.string().min(1)).default([]),
});
export type JudgeSpec = z.infer<typeof JudgeSpec>;

const Task = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "task id may only contain letters, digits, _ and -"),
  prompt: z.string().min(1),
  /** Directory (relative to the suite file) copied into the workspace before the run. */
  fixtures: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  assertions: z.array(Assertion).min(1, "a task needs at least one assertion"),
  judge: JudgeSpec.optional(),
});

const SuiteFile = z.strictObject({
  suite: z.string().min(1),
  defaults: z
    .strictObject({
      timeoutMs: z.number().int().positive().default(180_000),
      repeat: z.number().int().positive().default(3),
    })
    .default({ timeoutMs: 180_000, repeat: 3 }),
  tasks: z.array(Task).min(1),
});

export interface ResolvedTask {
  id: string;
  prompt: string;
  /** Absolute path or undefined. */
  fixturesDir?: string;
  timeoutMs: number;
  assertions: Assertion[];
  judge?: JudgeSpec;
}

export interface Suite {
  name: string;
  repeat: number;
  tasks: ResolvedTask[];
}

export function parseSuite(source: string, baseDir: string): Suite {
  const parsed = SuiteFile.safeParse(parse(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "suite"}: ${i.message}`);
    throw new Error(`Invalid benchmark suite:\n  ${issues.join("\n  ")}`);
  }
  const { suite, defaults, tasks } = parsed.data;
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`Invalid benchmark suite: duplicate task id "${t.id}"`);
    ids.add(t.id);
  }
  return {
    name: suite,
    repeat: defaults.repeat,
    tasks: tasks.map((t) => ({
      id: t.id,
      prompt: t.prompt,
      fixturesDir: t.fixtures ? resolve(baseDir, t.fixtures) : undefined,
      timeoutMs: t.timeoutMs ?? defaults.timeoutMs,
      assertions: t.assertions,
      judge: t.judge,
    })),
  };
}

export async function loadSuite(file: string): Promise<Suite> {
  const abs = resolve(file);
  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch {
    throw new Error(`Cannot read benchmark suite ${abs}`);
  }
  return parseSuite(source, dirname(abs));
}
