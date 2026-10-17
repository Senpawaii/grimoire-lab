import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentAdapter, loadSkill, ResultStore } from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "./program.js";
import { scaffoldSkill } from "./scaffold.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cli-commands-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** Writes output.txt unless the installed skill's SKILL.md says the version is broken. */
const fake = (): AgentAdapter => {
  const installed = new Set<string>();
  return {
    id: "fake",
    detect: async () => ({ available: true, version: "1.0" }),
    install: async (skill, ws) => {
      if (skill.description !== "broken") installed.add(ws.root);
    },
    run: async (_req, ws) => {
      const ok = installed.has(ws.root);
      if (ok) await writeFile(join(ws.dir, "output.txt"), "done");
      return {
        status: "completed",
        transcript: ok ? [{ type: "skill_loaded", skill: "demo" }] : [],
        finalMessage: "ok",
        durationMs: 5,
        rawOutput: "",
        usage: { tokens: 10 },
      };
    },
  };
};

const writeSkillMd = (dir: string, version: string, description: string) =>
  writeFile(
    join(dir, "SKILL.md"),
    `---\nname: demo\ndescription: ${description}\nversion: ${version}\n---\nbody ${description}\n`,
  );

async function run(args: string[], adapter: () => AgentAdapter = fake) {
  const lines: string[] = [];
  await createProgram((l) => lines.push(l), adapter).parseAsync(["node", "grimoire", ...args]);
  return lines.join("\n");
}

describe("propose", () => {
  it("benchmarks the candidate against the current skill on the current suite and prints the verdict", async () => {
    const current = await scaffoldSkill("demo", tmp);
    const candidate = await scaffoldSkill("demo", join(tmp, "cand"));
    await writeSkillMd(current, "0.1.0", "older");
    await writeSkillMd(candidate, "0.2.0", "newer");
    const out = join(tmp, "out");

    const text = await run([
      "propose",
      current,
      "--candidate",
      candidate,
      "--repeat",
      "5",
      "--out",
      out,
    ]);

    expect(text).toContain("demo-basic: 1 task(s) x 5 repeat(s) x 2 variants");
    expect(text).toContain("[demo@0.1.0] example #1 ✓");
    expect(text).toContain("[demo@0.2.0] example #5 ✓");
    expect(text).not.toContain("baseline");
    expect(text).toMatch(/demo@0\.1\.0\s+5\/5/);
    expect(text).toMatch(/demo@0\.2\.0\s+5\/5/);
    expect(text).toContain("Verdict: same (demo@0.2.0 vs demo@0.1.0)");
    expect(text).toContain("pass rate +0pp · n 5 vs 5 (infra errors 0 vs 0) · not significant");
    expect(text).toContain(`Saved to ${join(out, "runs", "1")}`);

    const store = new ResultStore(join(out, "results.db"));
    expect(store.getResult(1)?.comparisons[0]).toMatchObject({
      kind: "version-vs-version",
      subject: "demo@0.2.0",
      reference: "demo@0.1.0",
    });
    store.close();
  });

  it("reports a candidate that does worse, and uses the current skill's suite for both", async () => {
    const current = await scaffoldSkill("demo", tmp);
    const candidate = await scaffoldSkill("demo", join(tmp, "cand"));
    await rm(join(candidate, "grimoire.bench.yaml")); // staged candidates carry no suite
    await writeSkillMd(candidate, "0.2.0", "broken");

    const text = await run([
      "propose",
      current,
      "--candidate",
      candidate,
      "--repeat",
      "5",
      "--out",
      join(tmp, "out"),
    ]);

    expect(text).toContain("Verdict: worse (demo@0.2.0 vs demo@0.1.0)");
    expect(text).toContain("pass rate -100pp");
    expect(text).toContain(
      "· significant: gate needs 5 trials per side and a pass-rate delta of at least 10pp",
    );
  });

  it("requires --candidate and rejects an identical candidate before creating any results", async () => {
    const current = await scaffoldSkill("demo", tmp);
    const out = join(tmp, "out");
    await expect(run(["propose", current, "--out", out])).rejects.toThrow(/--candidate/);
    await expect(run(["propose", current, "--candidate", current, "--out", out])).rejects.toThrow(
      /identical contents/,
    );
    expect(existsSync(join(out, "results.db"))).toBe(false);
  });

  it("rejects an unknown agent", async () => {
    const current = await scaffoldSkill("demo", tmp);
    const candidate = await scaffoldSkill("demo", join(tmp, "cand"));
    await writeSkillMd(candidate, "0.2.0", "newer");
    await expect(
      createProgram(() => {}).parseAsync([
        "node",
        "grimoire",
        "propose",
        current,
        "--candidate",
        candidate,
        "--agent",
        "nope",
        "--out",
        join(tmp, "out"),
      ]),
    ).rejects.toThrow(/Unknown agent "nope"/);
  });
});

describe("resolve", () => {
  it("pins name, name@version and digest refs from --dir to name@version digest", async () => {
    const skills = join(tmp, "skills");
    const dir = await scaffoldSkill("demo", skills);
    const { digest } = await loadSkill(dir);

    expect(await run(["resolve", "demo", "--dir", skills])).toBe(`demo@0.1.0 ${digest}`);
    expect(await run(["resolve", "demo@0.1.0", "--dir", skills])).toBe(`demo@0.1.0 ${digest}`);
    expect(await run(["resolve", digest, "--dir", skills])).toBe(`demo@0.1.0 ${digest}`);
    await expect(run(["resolve", "missing", "--dir", skills])).rejects.toThrow(/not found/i);
  });

  it("prints just the name for a skill without a version", async () => {
    const skills = join(tmp, "skills");
    const dir = await scaffoldSkill("plain", skills);
    await writeFile(join(dir, "SKILL.md"), "---\nname: plain\ndescription: d\n---\nbody\n");
    const { digest } = await loadSkill(dir);
    expect(await run(["resolve", "plain", "--dir", skills])).toBe(`plain ${digest}`);
  });

  it("also searches a git repository (HEAD and name@semver tags) with --git", async () => {
    const repo = join(tmp, "repo");
    await mkdir(repo);
    const git = (...args: string[]) =>
      promisify(execFile)(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd: repo },
      );
    await git("init", "-q");
    const dir = await scaffoldSkill("demo", join(repo, "skills"));
    await git("add", "-A");
    await git("commit", "-q", "-m", "v1");
    await git("tag", "demo@0.1.0");
    const { digest } = await loadSkill(dir);

    const empty = join(tmp, "empty");
    expect(
      await run(["resolve", "demo@0.1.0", "--dir", empty, "--git", repo, "--git-path", "skills"]),
    ).toBe(`demo@0.1.0 ${digest}`);
    await expect(
      run(["resolve", "demo", "--dir", empty, "--git", repo, "--git-path", "nope"]),
    ).rejects.toThrow(/not found/i);
  });
});
