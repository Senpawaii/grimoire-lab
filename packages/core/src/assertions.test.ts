import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AssertionContext, evaluateAssertion } from "./assertions.js";
import type { Assertion } from "./suite.js";
import type { RunResult, Skill, TranscriptEvent } from "./types.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assert-test-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const skill: Skill = { dir: "/x", name: "demo", description: "d", digest: "sha256:0" };

function ctx(over: Partial<RunResult> = {}, withSkill = true): AssertionContext {
  return {
    ws: { root, dir: root },
    skill: withSkill ? skill : undefined,
    result: {
      status: "completed",
      transcript: [],
      finalMessage: "",
      durationMs: 1000,
      rawOutput: "",
      ...over,
    },
  };
}

const run = (a: Assertion, c = ctx()) => evaluateAssertion(a, c);

describe("file assertions", () => {
  it("file_exists", async () => {
    await writeFile(join(root, "a.txt"), "x");
    expect((await run({ type: "file_exists", path: "a.txt" })).passed).toBe(true);
    expect((await run({ type: "file_exists", path: "b.txt" })).passed).toBe(false);
  });

  it("file_contains matches by regex and fails on missing file", async () => {
    await writeFile(join(root, "t.csv"), "Q3,42\n");
    expect((await run({ type: "file_contains", path: "t.csv", regex: "Q3,\\d+" })).passed).toBe(
      true,
    );
    expect((await run({ type: "file_contains", path: "t.csv", regex: "Q4" })).passed).toBe(false);
    const missing = await run({ type: "file_contains", path: "nope", regex: "x" });
    expect(missing).toMatchObject({
      passed: false,
      detail: expect.stringContaining("does not exist"),
    });
  });

  it("refuses paths that escape the workspace instead of reading them", async () => {
    const r = await run({ type: "file_exists", path: "../outside.txt" });
    expect(r).toMatchObject({
      passed: false,
      detail: expect.stringContaining("escapes the workspace"),
    });
  });
});

describe("command", () => {
  it("compares the exit code", async () => {
    expect(
      (await run({ type: "command", run: 'node -e "process.exit(0)"', exitCode: 0 })).passed,
    ).toBe(true);
    expect(
      (await run({ type: "command", run: 'node -e "process.exit(3)"', exitCode: 0 })).passed,
    ).toBe(false);
    expect(
      (await run({ type: "command", run: 'node -e "process.exit(3)"', exitCode: 3 })).passed,
    ).toBe(true);
  });

  it("runs in the workspace directory", async () => {
    await writeFile(
      join(root, "check.js"),
      "process.exit(require('fs').existsSync('marker') ? 0 : 1)",
    );
    await writeFile(join(root, "marker"), "");
    expect((await run({ type: "command", run: "node check.js", exitCode: 0 })).passed).toBe(true);
  });
});

describe("transcript_contains", () => {
  const transcript: TranscriptEvent[] = [
    { type: "message", role: "assistant", text: "using pdftotext" },
    { type: "tool_call", id: "1", name: "Bash", input: { command: "pdftotext report.pdf" } },
    { type: "tool_call", id: "2", name: "Read", input: { file_path: "notes.md" } },
  ];

  it("restricts the search to the named tool's input", async () => {
    const c = ctx({ transcript });
    expect(
      (await run({ type: "transcript_contains", tool: "Bash", pattern: "pdftotext" }, c)).passed,
    ).toBe(true);
    expect(
      (await run({ type: "transcript_contains", tool: "Read", pattern: "pdftotext" }, c)).passed,
    ).toBe(false);
  });

  it("without a tool, searches messages and tool calls", async () => {
    const c = ctx({ transcript });
    expect((await run({ type: "transcript_contains", pattern: "notes\\.md" }, c)).passed).toBe(
      true,
    );
    expect((await run({ type: "transcript_contains", pattern: "absent" }, c)).passed).toBe(false);
  });
});

describe("skill_loaded", () => {
  const loaded = ctx({ transcript: [{ type: "skill_loaded", skill: "demo" }] });

  it("passes only when the installed skill was invoked", async () => {
    expect((await run({ type: "skill_loaded" }, loaded)).passed).toBe(true);
    expect((await run({ type: "skill_loaded" }, ctx())).passed).toBe(false);
    const other = ctx({ transcript: [{ type: "skill_loaded", skill: "other" }] });
    expect((await run({ type: "skill_loaded" }, other)).passed).toBe(false);
  });

  it("is skipped (passes) in the baseline cell", async () => {
    const r = await run({ type: "skill_loaded" }, ctx({}, false));
    expect(r).toMatchObject({ passed: true, detail: expect.stringContaining("skipped") });
  });
});

describe("max", () => {
  it("checks tokens, duration and cost against the limit (inclusive)", async () => {
    const c = ctx({ durationMs: 5000, usage: { tokens: 100, costUsd: 0.5 } });
    expect((await run({ type: "max", metric: "tokens", value: 100 }, c)).passed).toBe(true);
    expect((await run({ type: "max", metric: "tokens", value: 99 }, c)).passed).toBe(false);
    expect((await run({ type: "max", metric: "durationMs", value: 4999 }, c)).passed).toBe(false);
    expect((await run({ type: "max", metric: "costUsd", value: 1 }, c)).passed).toBe(true);
  });

  it("fails, rather than passing vacuously, when the agent reported no usage", async () => {
    const r = await run({ type: "max", metric: "tokens", value: 1e9 });
    expect(r).toMatchObject({ passed: false, detail: expect.stringContaining("no tokens") });
  });
});
