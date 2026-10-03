import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Workspace } from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCode } from "./claude-code.js";

// A stand-in `claude` executable on PATH. It echoes what it observed (stdin prompt, cwd, env,
// args) as the result text so tests can assert how the adapter invoked it.
const FAKE_SCRIPT = `
import { existsSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("9.9.9 (Claude Code)"); process.exit(0); }
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const prompt = readFileSync(0, "utf8");
// Real-clock hang on purpose: this exercises execa's actual timeout/kill against a live child
// process, which fake timers cannot do. The child exits on its own so a failed kill cannot leak.
if (mode === "hang") { setTimeout(() => process.exit(0), 8000); }
else if (mode === "crash") { console.error("boom"); process.exit(2); }
else {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const info = JSON.stringify({
    prompt, cwd: process.cwd(), cfg,
    creds: existsSync(cfg + "/.credentials.json"),
    args: process.argv.slice(2),
  });
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  out({
    type: "result", subtype: mode === "error" ? "error_max_turns" : "success",
    is_error: mode === "error", result: info, total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2 },
  });
}
`;

const SAVED = ["PATH", "FAKE_CLAUDE_MODE", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let tmp: string;
let ws: Workspace;
let loginDir: string;

beforeEach(async () => {
  for (const k of SAVED) saved[k] = process.env[k];
  tmp = await mkdtemp(join(tmpdir(), "cc-run-test-"));

  const bin = join(tmp, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "fake.mjs"), FAKE_SCRIPT);
  if (process.platform === "win32") {
    await writeFile(join(bin, "claude.cmd"), '@echo off\r\nnode "%~dp0fake.mjs" %*\r\n');
  } else {
    await writeFile(join(bin, "claude"), '#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n');
    await chmod(join(bin, "claude"), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  process.env.FAKE_CLAUDE_MODE = "ok";
  delete process.env.ANTHROPIC_API_KEY;

  loginDir = join(tmp, "login");
  await mkdir(loginDir);
  await writeFile(join(loginDir, ".credentials.json"), "{}");
  process.env.CLAUDE_CONFIG_DIR = loginDir;

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

describe("claudeCode.detect", () => {
  it("reports the version of the claude on PATH", async () => {
    expect(await claudeCode.detect()).toEqual({ available: true, version: "9.9.9" });
  });

  it("reports unavailable when no claude is on PATH", async () => {
    process.env.PATH = join(tmp, "login");
    expect(await claudeCode.detect()).toEqual({ available: false });
  });
});

describe("claudeCode.run", () => {
  it("passes the prompt on stdin, runs in the workspace with an isolated config dir holding only credentials", async () => {
    const r = await claudeCode.run(
      { prompt: "do the thing", timeoutMs: 20_000, model: "haiku" },
      ws,
    );

    expect(r.status).toBe("completed");
    const seen = JSON.parse(r.finalMessage);
    expect(seen.prompt).toBe("do the thing");
    expect(seen.cwd).toBe(ws.dir);
    expect(seen.cfg).toBe(join(ws.root, "claude-config"));
    expect(seen.creds).toBe(true);
    expect(seen.args).toEqual(
      expect.arrayContaining(["-p", "--output-format", "stream-json", "--no-session-persistence"]),
    );
    expect(seen.args.join(" ")).toContain("--model haiku");
    expect(r.usage).toEqual({ tokens: 3, costUsd: 0.01 });
    expect(r.transcript).toEqual([{ type: "message", role: "assistant", text: "working" }]);
    expect(r.rawOutput).toContain('"type":"result"');
  });

  it("omits --model when none is requested", async () => {
    const r = await claudeCode.run({ prompt: "p", timeoutMs: 20_000 }, ws);
    expect(JSON.parse(r.finalMessage).args).not.toContain("--model");
  });

  it("passes an empty --tools argument to disable every tool, and omits --tools by default", async () => {
    const none = await claudeCode.run({ prompt: "p", timeoutMs: 20_000, tools: [] }, ws);
    const args: string[] = JSON.parse(none.finalMessage).args;
    expect(args[args.indexOf("--tools") + 1]).toBe("");

    const some = await claudeCode.run(
      { prompt: "p", timeoutMs: 20_000, tools: ["Read", "Grep"] },
      ws,
    );
    const args2: string[] = JSON.parse(some.finalMessage).args;
    expect(args2[args2.indexOf("--tools") + 1]).toBe("Read,Grep");

    const dflt = await claudeCode.run({ prompt: "p", timeoutMs: 20_000 }, ws);
    expect(JSON.parse(dflt.finalMessage).args).not.toContain("--tools");
  });

  it("does not copy credentials when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "nowhere");
    const r = await claudeCode.run({ prompt: "p", timeoutMs: 20_000 }, ws);
    expect(r.status).toBe("completed");
    expect(JSON.parse(r.finalMessage).creds).toBe(false);
  });

  it("refuses to run unisolated when there are no credentials to copy", async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "nowhere");
    await expect(claudeCode.run({ prompt: "p", timeoutMs: 20_000 }, ws)).rejects.toThrow(
      /Cannot isolate the Claude config/,
    );
  });

  it("maps an error result to status error with the agent's reason", async () => {
    process.env.FAKE_CLAUDE_MODE = "error";
    const r = await claudeCode.run({ prompt: "p", timeoutMs: 20_000 }, ws);
    expect(r.status).toBe("error");
    expect(r.error).toContain("prompt");
  });

  it("reports a crash with the exit code and stderr when no result event was produced", async () => {
    process.env.FAKE_CLAUDE_MODE = "crash";
    const r = await claudeCode.run({ prompt: "p", timeoutMs: 20_000 }, ws);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/exited 2 without a result: boom/);
  });

  it("times out a hung agent", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const r = await claudeCode.run({ prompt: "p", timeoutMs: 500 }, ws);
    expect(r.status).toBe("timeout");
    expect(r.error).toContain("timed out after 500ms");
  }, 30_000);
});
