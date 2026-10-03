import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCode, parseStreamJson } from "./claude-code.js";
import { getAdapter } from "./index.js";

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");

// Shapes captured from `claude -p --output-format stream-json --verbose` (claude 2.1.x).
const skillRun = lines(
  { type: "system", subtype: "init", skills: ["hello-probe"] },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } },
  {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tu1", name: "Skill", input: { skill: "hello-probe" } }],
    },
  },
  {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "Launching skill: hello-probe" },
      ],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "text", text: "Base directory for this skill: ..." }] },
    isSynthetic: true,
  },
  { type: "assistant", message: { content: [{ type: "text", text: "The word is PLUMBOB." }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "The word is PLUMBOB.",
    total_cost_usd: 0.027,
    usage: {
      input_tokens: 19,
      cache_creation_input_tokens: 10929,
      cache_read_input_tokens: 43389,
      output_tokens: 194,
    },
  },
);

describe("parseStreamJson", () => {
  it("extracts messages, tool calls, results, skill invocations, usage and final message", () => {
    const p = parseStreamJson(skillRun);
    expect(p.transcript).toEqual([
      { type: "tool_call", id: "tu1", name: "Skill", input: { skill: "hello-probe" } },
      { type: "skill_loaded", skill: "hello-probe" },
      { type: "tool_result", id: "tu1", content: "Launching skill: hello-probe", isError: false },
      { type: "message", role: "assistant", text: "The word is PLUMBOB." },
    ]);
    expect(p.finalMessage).toBe("The word is PLUMBOB.");
    expect(p.usage).toEqual({ tokens: 19 + 10929 + 43389 + 194, costUsd: 0.027 });
    expect(p.resultError).toBeNull();
  });

  it("joins text blocks of array-valued tool results and keeps the error flag", () => {
    const p = parseStreamJson(
      lines({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "a",
              is_error: true,
              content: [
                { type: "text", text: "l1" },
                { type: "text", text: "l2" },
              ],
            },
          ],
        },
      }),
    );
    expect(p.transcript).toEqual([
      { type: "tool_result", id: "a", content: "l1\nl2", isError: true },
    ]);
  });

  it("flags error results and leaves resultError undefined when no result event arrived", () => {
    const err = parseStreamJson(
      lines({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }),
    );
    expect(err.resultError).toBe("error_max_turns");
    expect(parseStreamJson("not json\n{}\n").resultError).toBeUndefined();
  });
});

describe("claudeCode.install", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cc-test-"));
  });
  afterEach(() => rm(tmp, { recursive: true, force: true }));

  it("copies the skill to .claude/skills/<name> without the benchmark suite or fixtures", async () => {
    const src = join(tmp, "src");
    await mkdir(join(src, "scripts"), { recursive: true });
    await mkdir(join(src, "fixtures"));
    await writeFile(join(src, "SKILL.md"), "---\nname: demo\ndescription: d\n---\n");
    await writeFile(join(src, "scripts", "run.sh"), "echo");
    await writeFile(join(src, "grimoire.bench.yaml"), "suite: s");
    await writeFile(join(src, "fixtures", "a.txt"), "secret answer");
    const ws = { root: tmp, dir: join(tmp, "work") };
    await mkdir(ws.dir);
    const skill: Skill = { dir: src, name: "demo", description: "d", digest: "sha256:0" };

    await claudeCode.install(skill, ws);

    const dest = join(ws.dir, ".claude", "skills", "demo");
    expect(await readFile(join(dest, "scripts", "run.sh"), "utf8")).toBe("echo");
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "grimoire.bench.yaml"))).toBe(false);
    expect(existsSync(join(dest, "fixtures"))).toBe(false);
  });
});

describe("getAdapter", () => {
  it("resolves claude-code and rejects unknown ids with the available list", () => {
    expect(getAdapter("claude-code")).toBe(claudeCode);
    expect(() => getAdapter("nope")).toThrow(/Available: claude-code/);
  });
});
