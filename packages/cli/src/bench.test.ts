import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentAdapter, ResultStore } from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "./program.js";
import { scaffoldSkill } from "./scaffold.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cli-bench-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** Writes output.txt in the workspace; reports the skill as loaded only when installed. */
const fake = (): AgentAdapter => {
  const installed = new Set<string>();
  return {
    id: "fake",
    detect: async () => ({ available: true, version: "1.0" }),
    install: async (_skill, ws) => {
      installed.add(ws.root);
    },
    run: async (_req, ws) => {
      await writeFile(join(ws.dir, "output.txt"), "done");
      return {
        status: "completed",
        transcript: installed.has(ws.root) ? [{ type: "skill_loaded", skill: "demo" }] : [],
        finalMessage: "ok",
        durationMs: 5,
        rawOutput: "",
        usage: { tokens: 10 },
      };
    },
  };
};

describe("bench", () => {
  it("runs the scaffolded suite, prints per-trial lines and the report, and saves the run", async () => {
    const skillDir = await scaffoldSkill("demo", tmp);
    const out = join(tmp, "out");
    const lines: string[] = [];

    await createProgram(
      (l) => lines.push(l),
      () => fake(),
    ).parseAsync(["node", "grimoire", "bench", skillDir, "--repeat", "2", "--out", out]);

    const text = lines.join("\n");
    expect(text).toContain("demo-basic: 1 task(s) x 2 repeat(s) x 2 cells");
    expect(text).toContain("[baseline] example #1 ✓");
    expect(text).toContain("[with-skill] example #2 ✓");
    expect(text).toMatch(/baseline\s+2\/2/);
    expect(text).toMatch(/with-skill\s+2\/2/);

    const store = new ResultStore(join(out, "results.db"));
    expect(store.listTrials(1)).toHaveLength(4);
    store.close();
    expect(existsSync(join(out, "runs", "1"))).toBe(true);
  });

  it("rejects a non-positive --repeat", async () => {
    const skillDir = await scaffoldSkill("demo", tmp);
    await expect(
      createProgram(
        () => {},
        () => fake(),
      ).parseAsync(["node", "grimoire", "bench", skillDir, "--repeat", "0"]),
    ).rejects.toThrow(/positive integer/);
  });
});
