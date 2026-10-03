import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkill, loadSuite, ResultStore } from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "./program.js";
import { scaffoldSkill } from "./scaffold.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cli-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe("scaffoldSkill", () => {
  it("creates a skill and suite that the loaders accept", async () => {
    const dir = await scaffoldSkill("my-skill", tmp);
    const skill = await loadSkill(dir);
    expect(skill).toMatchObject({ name: "my-skill", version: "0.1.0" });
    const suite = await loadSuite(join(dir, "grimoire.bench.yaml"));
    expect(suite.tasks).toHaveLength(1);
  });

  it("rejects invalid names and refuses to overwrite an existing skill", async () => {
    await expect(scaffoldSkill("Bad Name", tmp)).rejects.toThrow(/kebab-case/);
    await expect(scaffoldSkill("../escape", tmp)).rejects.toThrow(/kebab-case/);
    await scaffoldSkill("dup", tmp);
    await expect(scaffoldSkill("dup", tmp)).rejects.toThrow(/already exists/);
  });
});

describe("commands", () => {
  it("`new` creates the skill under --dir", async () => {
    const lines: string[] = [];
    await createProgram((l) => lines.push(l)).parseAsync([
      "node",
      "grimoire",
      "new",
      "demo",
      "--dir",
      tmp,
    ]);
    expect(existsSync(join(tmp, "demo", "SKILL.md"))).toBe(true);
    expect(lines[0]).toContain("Created");
  });

  it("`report` prints the latest run from the output directory, and errors when there is none", async () => {
    const out = join(tmp, "out");
    await mkdir(out);
    const run = (args: string[]) => {
      const lines: string[] = [];
      return createProgram((l) => lines.push(l))
        .parseAsync(["node", "grimoire", "report", ...args, "--out", out])
        .then(() => lines.join("\n"));
    };
    await expect(run([])).rejects.toThrow(/No runs saved yet/);

    const store = new ResultStore(join(out, "results.db"));
    const id = store.createRun({
      suite: "s",
      agent: "claude-code",
      variants: [
        { label: "baseline" },
        { label: "with-skill", skillName: "demo", skillDigest: "sha256:0000000000000000000" },
      ],
    });
    store.close();
    expect(await run([])).toContain("with-skill: demo");
    expect(await run([String(id)])).toContain(`run ${id}`);
    await expect(run(["99"])).rejects.toThrow(/No run with id 99/);
  });

  it("`bench` rejects an unknown agent before running anything", async () => {
    const dir = await scaffoldSkill("demo", tmp);
    await expect(
      createProgram(() => {}).parseAsync([
        "node",
        "grimoire",
        "bench",
        dir,
        "--agent",
        "nope",
        "--out",
        join(tmp, "o"),
      ]),
    ).rejects.toThrow(/Unknown agent "nope"/);
  });
});
