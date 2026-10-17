import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type AgentAdapter,
  benchSkill,
  loadSkill,
  loadSuite,
  ResultStore,
  ResumeMismatch,
} from "@grimoire/core";
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

describe("propose --concurrency", () => {
  it("runs the proposal in parallel", async () => {
    const current = await scaffoldSkill("demo", tmp);
    const candidate = await scaffoldSkill("demo", join(tmp, "cand"));
    await writeSkillMd(candidate, "0.2.0", "newer");
    const out = join(tmp, "out");
    const text = await run([
      "propose",
      current,
      "--candidate",
      candidate,
      "--repeat",
      "3",
      "--concurrency",
      "3",
      "--out",
      out,
    ]);
    expect(text).toContain("Verdict:");
    const store = new ResultStore(join(out, "results.db"));
    expect(store.listTrials(1)).toHaveLength(6);
    store.close();
  });
});

describe("resume", () => {
  /** Leaves run 1 in `<out>/results.db` aborted after `after` of its 6 trials. */
  async function interrupted(skillDir: string, out: string, after = 2) {
    const store = new ResultStore(join(out, "results.db"));
    const ac = new AbortController();
    let n = 0;
    try {
      await expect(
        benchSkill({
          skill: await loadSkill(skillDir),
          suite: await loadSuite(join(skillDir, "grimoire.bench.yaml")),
          adapter: fake(),
          outDir: out,
          store,
          signal: ac.signal,
          onTrial: () => {
            if (++n === after) ac.abort();
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      store.close();
    }
  }

  const trialCount = (out: string) => {
    const store = new ResultStore(join(out, "results.db"));
    try {
      return store.listTrials(1).length;
    } finally {
      store.close();
    }
  };

  it("finishes an aborted run from --skill, runs only the missing trials and prints the report", async () => {
    const skillDir = await scaffoldSkill("demo", tmp);
    const out = join(tmp, "out");
    await interrupted(skillDir, out);
    expect(trialCount(out)).toBe(2);

    const text = await run([
      "resume",
      "1",
      "--skill",
      skillDir,
      "--concurrency",
      "2",
      "--out",
      out,
    ]);

    expect(text).toContain("Resuming run 1 (demo-basic) on fake");
    expect(text.match(/example #/g)).toHaveLength(4);
    expect(text).toMatch(/with-skill\s+3\/3/);
    expect(text).toContain(`Saved to ${join(out, "runs", "1")}`);
    expect(trialCount(out)).toBe(6);
  });

  it("finds the skill by digest in --dir and the suite next to it, or from --suite", async () => {
    const skills = join(tmp, "skills");
    const skillDir = await scaffoldSkill("demo", skills);
    const out = join(tmp, "out");
    await interrupted(skillDir, out, 5);
    expect(await run(["resume", "1", "--dir", skills, "--out", out])).toContain("Resuming run 1");
    expect(trialCount(out)).toBe(6);

    // Complete now: nothing runs, the report is printed again; --suite points at a copy.
    const copy = join(tmp, "suite-copy.yaml");
    await copyFile(join(skillDir, "grimoire.bench.yaml"), copy);
    const text = await run(["resume", "1", "--dir", skills, "--suite", copy, "--out", out]);
    expect(text).not.toContain("example #");
    expect(text).toMatch(/baseline\s+0\/3/);
    expect(text).toMatch(/with-skill\s+3\/3/);
  });

  it("refuses a skill that changed since the run, naming the missing digest", async () => {
    const skillDir = await scaffoldSkill("demo", tmp);
    const out = join(tmp, "out");
    await interrupted(skillDir, out);
    await writeSkillMd(skillDir, "0.1.1", "edited");

    const err = await run(["resume", "1", "--skill", skillDir, "--out", out]).catch((e) => e);
    expect(err).toBeInstanceOf(ResumeMismatch);
    expect(err).toMatchObject({ kind: "skill" });
    expect(err.message).toMatch(/not available any more/);
    expect(trialCount(out)).toBe(2);
  });

  it("refuses a suite that changed since the run", async () => {
    const skillDir = await scaffoldSkill("demo", tmp);
    const out = join(tmp, "out");
    await interrupted(skillDir, out);
    const yamlPath = join(skillDir, "grimoire.bench.yaml");
    await writeFile(yamlPath, (await readFile(yamlPath, "utf8")).replace("Describe", "Explain"));

    await expect(run(["resume", "1", "--skill", skillDir, "--out", out])).rejects.toMatchObject({
      name: "ResumeMismatch",
      kind: "suite",
    });
    expect(trialCount(out)).toBe(2);
  });

  it("uses the agent of the run, refusing --agent for another one", async () => {
    const skillDir = await scaffoldSkill("demo", tmp);
    const out = join(tmp, "out");
    await interrupted(skillDir, out);
    const other = (): AgentAdapter => ({ ...fake(), id: "other" });

    await expect(
      run(["resume", "1", "--skill", skillDir, "--agent", "other", "--out", out], other),
    ).rejects.toMatchObject({ name: "ResumeMismatch", kind: "agent" });
    expect(trialCount(out)).toBe(2);
  });

  it("rejects an unknown run, a bad id and a bad --concurrency", async () => {
    const skillDir = await scaffoldSkill("demo", tmp);
    const out = join(tmp, "out");
    await expect(run(["resume", "7", "--out", out])).rejects.toThrow("No run with id 7");
    await expect(run(["resume", "x", "--out", out])).rejects.toThrow(/positive integer/);
    await expect(
      run(["resume", "1", "--skill", skillDir, "--concurrency", "0", "--out", out]),
    ).rejects.toThrow(/positive integer/);
  });

  it("needs --suite when the run has no skill arm to find one next to", async () => {
    const out = join(tmp, "out");
    const store = new ResultStore(join(out, "results.db"));
    store.createRun({
      suite: "s",
      agent: "fake",
      suiteDigest: "sha256:x",
      taskIds: ["t"],
      repeat: 1,
      variants: [{ label: "a" }, { label: "b" }],
    });
    store.close();
    await expect(run(["resume", "1", "--out", out])).rejects.toThrow(/pass --suite/);
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
