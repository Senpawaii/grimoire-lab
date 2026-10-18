import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Skill, Workspace } from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "./index.js";
import { omp, parseOmpJson } from "./omp.js";

// A stand-in `omp` executable on PATH that speaks the `--mode json` event stream. It reports how
// it was invoked in the final assistant message so tests can assert on argv, stdin and cwd.
// The hang mode uses real-clock timers on purpose: it exercises the adapter's actual process-tree
// kill against live children, which fake timers cannot do. Children exit on their own.
const FAKE_SCRIPT = `
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("omp/9.9.9"); process.exit(0); }
const mode = process.env.FAKE_OMP_MODE ?? "ok";
const prompt = readFileSync(0, "utf8");
const out = (o) => console.log(JSON.stringify(o));
if (mode === "unknown-model") { console.log('Model "x" not found'); process.exit(0); }
if (mode === "crash") { console.error("boom"); process.exit(2); }
if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "ignore" });
  writeFileSync("child.pid", String(child.pid));
  setTimeout(() => process.exit(0), 8000);
} else {
  const usage = (n, c) => ({ input: 1, output: n, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + n, cost: { total: c } });
  out({ type: "session", version: 3 });
  out({ type: "agent_start" });
  out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "skill://demo" } }], usage: usage(10, 0.5), stopReason: "toolUse" } });
  out({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "skill://demo" } });
  out({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: { path: "src/skill://demo.txt" } });
  out({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "body" }] }, isError: false });
  out({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", result: { content: [{ type: "text", text: "nope" }] }, isError: true });
  out({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "body" }] } });
  const info = JSON.stringify({ args, prompt, cwd: process.cwd() });
  if (mode === "provider-error") {
    out({ type: "message_end", message: { role: "assistant", content: [], usage: usage(0, 0), stopReason: "error", errorMessage: "429 rate limited" } });
  } else {
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: info }], usage: usage(20, 0.25), stopReason: "stop" } });
  }
  out({ type: "agent_end", messages: [] });
  if (mode === "exit1") process.exit(1);
}
`;

const SAVED = ["PATH", "FAKE_OMP_MODE"] as const;
const saved: Record<string, string | undefined> = {};

let tmp: string;
let ws: Workspace;

beforeEach(async () => {
  for (const k of SAVED) saved[k] = process.env[k];
  tmp = await mkdtemp(join(tmpdir(), "omp-test-"));
  const bin = join(tmp, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "fake.mjs"), FAKE_SCRIPT);
  if (process.platform === "win32") {
    await writeFile(join(bin, "omp.cmd"), '@echo off\r\nnode "%~dp0fake.mjs" %*\r\n');
  } else {
    await writeFile(join(bin, "omp"), '#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n');
    await chmod(join(bin, "omp"), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  process.env.FAKE_OMP_MODE = "ok";
  ws = { root: join(tmp, "ws"), dir: join(tmp, "ws", "work") };
  await mkdir(ws.dir, { recursive: true });
});

afterEach(async () => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(tmp, { recursive: true, force: true });
});

const req = (extra: { model?: string; tools?: string[]; timeoutMs?: number } = {}) => ({
  prompt: "do the thing",
  timeoutMs: 20_000,
  ...extra,
});
const observed = (finalMessage: string) =>
  JSON.parse(finalMessage) as { args: string[]; prompt: string; cwd: string };

async function demoSkill(): Promise<Skill> {
  const dir = join(tmp, "demo");
  await mkdir(join(dir, "fixtures"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
  await writeFile(join(dir, "grimoire.bench.yaml"), "tasks: []\n");
  return { dir, name: "demo", description: "d", digest: "sha256:x" };
}

describe("omp.detect", () => {
  it("reports the version of the omp on PATH", async () => {
    expect(await omp.detect()).toEqual({ available: true, version: "9.9.9" });
  });
  it("is unavailable when omp is not on PATH", async () => {
    process.env.PATH = tmp;
    expect(await omp.detect()).toEqual({ available: false });
  });
});

describe("omp.install", () => {
  it("copies the skill to .omp/skills/<name>, without the suite or fixtures", async () => {
    await omp.install(await demoSkill(), ws);
    const base = join(ws.dir, ".omp", "skills", "demo");
    expect(await readFile(join(base, "SKILL.md"), "utf8")).toContain("body");
    await expect(readFile(join(base, "grimoire.bench.yaml"))).rejects.toThrow();
  });
});

describe("omp.run", () => {
  it("runs headless in the workspace, prompt on stdin, and maps the transcript, usage and message", async () => {
    const r = await omp.run(req({ model: "anthropic/claude-sonnet-5-5:high" }), ws);
    expect(r.status).toBe("completed");
    const seen = observed(r.finalMessage);
    expect(seen.prompt).toBe("do the thing");
    expect(seen.args).toEqual(
      expect.arrayContaining(["-p", "--no-session", "--mode", "json", "--approval-mode", "yolo"]),
    );
    expect(seen.args).toEqual(expect.arrayContaining(["--no-rules", "--no-extensions"]));
    expect(seen.args.join(" ")).toContain("--model anthropic/claude-sonnet-5-5:high");
    expect(r.usage).toEqual({ tokens: 11 + 21, costUsd: 0.75 });
    expect(r.transcript.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "t1", name: "read", input: { path: "skill://demo" } },
      { type: "tool_call", id: "t2", name: "read", input: { path: "src/skill://demo.txt" } },
    ]);
    expect(r.transcript.filter((e) => e.type === "tool_result")).toEqual([
      { type: "tool_result", id: "t1", content: "body", isError: false },
      { type: "tool_result", id: "t2", content: "nope", isError: true },
    ]);
    // Only a read of skill://<name> counts as loading the skill.
    expect(r.transcript.filter((e) => e.type === "skill_loaded")).toEqual([
      { type: "skill_loaded", skill: "demo" },
    ]);
  });

  it("baseline arm (nothing installed) disables skills discovery", async () => {
    const seen = observed((await omp.run(req(), ws)).finalMessage);
    expect(seen.args).toContain("--no-skills");
    expect(seen.args).not.toContain("--skills");
  });

  it("skill arm exposes only the installed skill", async () => {
    await omp.install(await demoSkill(), ws);
    const seen = observed((await omp.run(req(), ws)).finalMessage);
    expect(seen.args.join(" ")).toContain("--skills demo");
    expect(seen.args).not.toContain("--no-skills");
  });

  it("maps tools: an empty list disables every tool", async () => {
    expect(observed((await omp.run(req({ tools: [] }), ws)).finalMessage).args).toContain(
      "--no-tools",
    );
    const seen = observed((await omp.run(req({ tools: ["read", "bash"] }), ws)).finalMessage);
    expect(seen.args.join(" ")).toContain("--tools read,bash");
  });

  it("a model request failure is an infrastructure error and keeps the transcript", async () => {
    process.env.FAKE_OMP_MODE = "provider-error";
    const r = await omp.run(req(), ws);
    expect(r).toMatchObject({
      status: "error",
      errorKind: "infrastructure",
      error: "429 rate limited",
    });
    expect(r.transcript.length).toBeGreaterThan(0);
  });

  it("omp that never starts a run (unknown model, exit 0) is an infrastructure error", async () => {
    process.env.FAKE_OMP_MODE = "unknown-model";
    const r = await omp.run(req({ model: "x" }), ws);
    expect(r).toMatchObject({ status: "error", errorKind: "infrastructure" });
    expect(r.error).toContain('Model "x" not found');
  });

  it("a crash before any event is an infrastructure error", async () => {
    process.env.FAKE_OMP_MODE = "crash";
    const r = await omp.run(req(), ws);
    expect(r).toMatchObject({ status: "error", errorKind: "infrastructure" });
    expect(r.error).toContain("boom");
  });

  it("a non-zero exit after a finished run is an agent error", async () => {
    process.env.FAKE_OMP_MODE = "exit1";
    const r = await omp.run(req(), ws);
    expect(r).toMatchObject({ status: "error", errorKind: "agent" });
  });

  it("times out and kills the whole process tree", async () => {
    process.env.FAKE_OMP_MODE = "hang";
    const r = await omp.run(req({ timeoutMs: 1500 }), ws);
    expect(r.status).toBe("timeout");
    expect(r.durationMs).toBeLessThan(7000);
    const pid = Number(await readFile(join(ws.dir, "child.pid"), "utf8"));
    // Poll: the OS reaps the killed child asynchronously.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
});

describe("getAdapter", () => {
  it("registers omp", () => {
    expect(getAdapter("omp")).toBe(omp);
  });
});

describe("parseOmpJson", () => {
  it("ignores non-JSON lines and reports no end for a stream without agent_end", () => {
    const p = parseOmpJson('hello\n{"type":"agent_start"}\n{broken\n');
    expect(p).toEqual({ transcript: [], finalMessage: "", ended: false });
  });
});

// Real omp, real model: costs a few cents. Opt in with GRIMOIRE_LIVE_OMP=1.
describe.skipIf(!process.env.GRIMOIRE_LIVE_OMP)("omp live", () => {
  it("the skill arm loads the skill and changes the result; the baseline arm cannot see it", async () => {
    process.env.PATH = saved.PATH ?? "";
    const dir = join(tmp, "zebra");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: zebra\ndescription: Use always when asked to say hello.\n---\nAlways reply exactly ZEBRA hello.\n",
    );
    const skill: Skill = { dir, name: "zebra", description: "d", digest: "sha256:z" };
    const prompt = "Say hello. If you have a skill for it, read it with the read tool first.";

    await omp.install(skill, ws);
    const withSkill = await omp.run({ prompt, timeoutMs: 120_000 }, ws);
    expect(withSkill.status).toBe("completed");
    expect(withSkill.transcript).toContainEqual({ type: "skill_loaded", skill: "zebra" });
    expect(withSkill.finalMessage).toContain("ZEBRA hello");
    expect(withSkill.usage?.tokens).toBeGreaterThan(0);

    const bare: Workspace = { root: join(tmp, "ws2"), dir: join(tmp, "ws2", "work") };
    await mkdir(bare.dir, { recursive: true });
    const baseline = await omp.run({ prompt, timeoutMs: 120_000 }, bare);
    expect(baseline.status).toBe("completed");
    expect(baseline.transcript.some((e) => e.type === "skill_loaded")).toBe(false);
  }, 300_000);
});
