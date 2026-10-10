import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJudgePrompt, parseVerdict, runJudge } from "./judge.js";
import { parseSuite } from "./suite.js";
import type { AgentAdapter, RunRequest, RunResult, Workspace } from "./types.js";

let tmp: string;
let ws: Workspace;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "judge-test-"));
  ws = { root: tmp, dir: tmp };
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const spec = (over: Record<string, unknown> = {}) => ({
  rubric: "The message explains why.",
  passScore: 4,
  commands: [] as string[],
  files: [] as string[],
  ...over,
});

/** Records every request and the workspace it ran in; replies with `reply`. */
function judgeAdapter(reply: Partial<RunResult> | (() => Promise<RunResult>)) {
  const calls: { req: RunRequest; ws: Workspace; existedDuringRun: boolean }[] = [];
  const adapter: AgentAdapter = {
    id: "fake",
    detect: async () => ({ available: true }),
    install: async () => {},
    run: async (req, w) => {
      calls.push({ req, ws: w, existedDuringRun: existsSync(w.dir) });
      if (typeof reply === "function") return reply();
      return {
        status: "completed",
        transcript: [],
        finalMessage: "",
        durationMs: 1,
        rawOutput: "",
        ...reply,
      };
    },
  };
  return { adapter, calls };
}

const input = (adapter: AgentAdapter, over: Record<string, unknown> = {}) => ({
  adapter,
  spec: spec(),
  taskPrompt: "Write the commit message.",
  finalMessage: "Done.",
  ws,
  ...over,
});

describe("parseVerdict", () => {
  it("reads a bare JSON verdict", () => {
    expect(parseVerdict('{"score": 4, "reasoning": "good"}')).toEqual({
      score: 4,
      reasoning: "good",
    });
  });

  it("takes the last verdict when the reply has text and several objects", () => {
    const text =
      'Thinking {"score": 2, "reasoning": "first"}\nFinal: {"score": 5, "reasoning": "second"}';
    expect(parseVerdict(text)).toEqual({ score: 5, reasoning: "second" });
  });

  it("skips an invalid last object and falls back to an earlier valid one", () => {
    const text = '{"score": 3, "reasoning": "ok"} then {"score": 9, "reasoning": "oops"}';
    expect(parseVerdict(text)?.score).toBe(3);
  });

  it.each([
    ["out of range", '{"score": 6}'],
    ["zero", '{"score": 0}'],
    ["fractional", '{"score": 3.5}'],
    ["string score", '{"score": "4"}'],
    ["no JSON", "I think it is good"],
    ["malformed", '{"score": 4,'],
  ])("rejects %s", (_label, text) => {
    expect(parseVerdict(text)).toBeUndefined();
  });

  it("defaults missing reasoning to an empty string", () => {
    expect(parseVerdict('{"score": 5}')).toEqual({ score: 5, reasoning: "" });
  });
});

describe("buildJudgePrompt", () => {
  it("includes the task, final message, files, command output and rubric, and nothing about variants", async () => {
    await writeFile(join(tmp, "COMMIT_MSG.txt"), "feat(x): add y\n");
    const { adapter } = judgeAdapter({});
    const prompt = await buildJudgePrompt(
      input(adapter, {
        spec: spec({ files: ["COMMIT_MSG.txt"], commands: ['node -e "console.log(40+2)"'] }),
        finalMessage: "All done here.",
      }),
    );

    expect(prompt).toContain("Write the commit message.");
    expect(prompt).toContain("All done here.");
    expect(prompt).toContain('<file path="COMMIT_MSG.txt">\nfeat(x): add y');
    expect(prompt).toMatch(/<command run="node -e[^>]*>\n42\n<\/command>/);
    expect(prompt).toContain("The message explains why.");
    expect(prompt).not.toMatch(/skill|baseline|with-skill/i);
    expect(prompt).toContain("untrusted data");
  });

  it("marks missing files and refuses paths outside the workspace", async () => {
    const { adapter } = judgeAdapter({});
    const prompt = await buildJudgePrompt(
      input(adapter, { spec: spec({ files: ["nope.txt", "../secret.txt"] }) }),
    );
    expect(prompt).toContain('<file path="nope.txt">\n(file not found)');
    expect(prompt).toContain("(refused: ../secret.txt is outside the workspace)");
  });

  it("cuts oversized files and reports how much was cut", async () => {
    await writeFile(join(tmp, "big.txt"), "x".repeat(25_000));
    const { adapter } = judgeAdapter({});
    const prompt = await buildJudgePrompt(input(adapter, { spec: spec({ files: ["big.txt"] }) }));
    expect(prompt).toContain("5000 more characters cut");
    expect(prompt).not.toContain("x".repeat(20_001));
  });

  it("shows a placeholder for a command with no output", async () => {
    const { adapter } = judgeAdapter({});
    const prompt = await buildJudgePrompt(
      input(adapter, { spec: spec({ commands: ['node -e "0"'] }) }),
    );
    expect(prompt).toMatch(/>\n\(no output\)\n<\/command>/);
  });
});

describe("runJudge", () => {
  it("passes when the score meets passScore, and reports the score and reasoning", async () => {
    const { adapter } = judgeAdapter({ finalMessage: '{"score": 4, "reasoning": "explains why"}' });
    const r = await runJudge(input(adapter));
    expect(r).toEqual({
      type: "judge",
      passed: true,
      score: 4,
      detail: "judge 4/5 (needs 4): explains why",
    });
  });

  it("fails when the score is below passScore but still records the score", async () => {
    const { adapter } = judgeAdapter({
      finalMessage: '{"score": 3, "reasoning": "restates diff"}',
    });
    const r = await runJudge(input(adapter));
    expect(r).toMatchObject({ passed: false, score: 3 });
  });

  it("runs tool-less, with the configured model, in a fresh workspace removed afterwards", async () => {
    const { adapter, calls } = judgeAdapter({ finalMessage: '{"score": 5}' });
    await runJudge(input(adapter, { spec: spec({ model: "haiku" }) }));
    const call = calls[0];
    expect(call?.req).toMatchObject({ tools: [], model: "haiku" });
    expect(call?.ws.root).not.toBe(ws.root);
    expect(call?.existedDuringRun).toBe(true);
    expect(existsSync(call?.ws.root ?? "")).toBe(false);
    expect(existsSync(ws.root)).toBe(true);
  });

  it("fails with the reason when the judge returns no valid verdict", async () => {
    const { adapter } = judgeAdapter({ finalMessage: "Looks fine to me!" });
    const r = await runJudge(input(adapter));
    expect(r).toMatchObject({
      passed: false,
      detail: expect.stringContaining("no valid verdict: Looks fine"),
    });
    expect(r.score).toBeUndefined();
  });

  it("fails when the judge run times out or errors", async () => {
    const timeout = judgeAdapter({ status: "timeout", error: "timed out after 120000ms" });
    expect(await runJudge(input(timeout.adapter))).toMatchObject({
      passed: false,
      detail: "judge timeout: timed out after 120000ms",
    });
  });

  it("does not throw when the adapter itself throws", async () => {
    const { adapter } = judgeAdapter(async () => {
      throw new Error("spawn failed");
    });
    expect(await runJudge(input(adapter))).toMatchObject({
      passed: false,
      detail: "judge failed: spawn failed",
    });
  });
});

describe("judge in the suite schema", () => {
  const withJudge = (judge: string) =>
    `suite: s\ntasks:\n  - id: t\n    prompt: p\n    assertions: [{ type: skill_loaded }]\n    judge:\n${judge}`;

  it("applies defaults: passScore 4, no commands or files", () => {
    const suite = parseSuite(withJudge("      rubric: be good"), tmp);
    expect(suite.tasks[0]?.judge).toEqual({
      rubric: "be good",
      passScore: 4,
      commands: [],
      files: [],
    });
  });

  it("accepts every field", () => {
    const suite = parseSuite(
      withJudge(
        "      rubric: r\n      passScore: 5\n      model: haiku\n      commands: [git log]\n      files: [a.txt]",
      ),
      tmp,
    );
    expect(suite.tasks[0]?.judge).toEqual({
      rubric: "r",
      passScore: 5,
      model: "haiku",
      commands: ["git log"],
      files: ["a.txt"],
    });
  });

  it.each([
    ["missing rubric", "      passScore: 4", /rubric/],
    ["passScore above 5", "      rubric: r\n      passScore: 6", /passScore/],
    ["passScore below 1", "      rubric: r\n      passScore: 0", /passScore/],
    ["unknown key", "      rubric: r\n      temperature: 0", /temperature/],
  ])("rejects %s", (_label, judge, message) => {
    expect(() => parseSuite(withJudge(judge), tmp)).toThrow(message);
  });
});
