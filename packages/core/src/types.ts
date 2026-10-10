export interface Skill {
  /** Absolute path of the skill folder. */
  dir: string;
  name: string;
  description: string;
  version?: string;
  /** sha256 over the skill's files (see digest.ts). */
  digest: string;
}

export type TranscriptEvent =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; isError: boolean }
  | { type: "skill_loaded"; skill: string };

export interface Usage {
  /** input + cache creation + cache read + output. */
  tokens: number;
  costUsd?: number;
}

export interface Workspace {
  /** Scratch root; owned by the engine and deleted after the trial. */
  root: string;
  /** Directory the agent runs in. */
  dir: string;
}

export interface RunRequest {
  prompt: string;
  timeoutMs: number;
  model?: string;
  /** Restrict the agent to these tools; an empty list disables all tools. Undefined = defaults. */
  tools?: string[];
}

export interface RunResult {
  status: "completed" | "timeout" | "error";
  transcript: TranscriptEvent[];
  finalMessage: string;
  usage?: Usage;
  durationMs: number;
  /** Unprocessed agent output, kept for debugging. */
  rawOutput: string;
  /** Set when status is "error". */
  error?: string;
}

export interface AgentAdapter {
  id: string;
  detect(): Promise<{ available: boolean; version?: string }>;
  /** Write the skill into the workspace in the agent's native location. */
  install(skill: Skill, ws: Workspace): Promise<void>;
  run(req: RunRequest, ws: Workspace): Promise<RunResult>;
}
