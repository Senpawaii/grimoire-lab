import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NoChange,
  proposeVersion,
  RewriterNotAvailable,
  type SkillRewriter,
  stageCandidate,
} from "./propose.js";
import type { BenchResult } from "./result.js";
import { loadSkill } from "./skill.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "propose-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const basis: BenchResult = {
  schemaVersion: 1,
  id: "1",
  startedAt: "2026-10-17T00:00:00.000Z",
  suite: { name: "s", digest: "sha256:suite", taskIds: ["t"] },
  repeat: 1,
  arms: [],
  comparisons: [],
};

async function makeSkill(frontmatter = "name: demo\ndescription: d\nversion: 1.0.0") {
  const dir = join(tmp, "src", "demo");
  await mkdir(join(dir, "references"), { recursive: true });
  await mkdir(join(dir, "fixtures"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\nBody\n`);
  await writeFile(join(dir, "references", "x.md"), "ref");
  await writeFile(join(dir, "grimoire.bench.yaml"), "suite: s");
  await writeFile(join(dir, "fixtures", "a.txt"), "fx");
  return loadSkill(dir);
}

describe("stageCandidate", () => {
  it("copies the skill without benchmark inputs, so the digest is unchanged", async () => {
    const current = await makeSkill();
    const staged = await stageCandidate(current, join(tmp, "out"));
    expect(staged.digest).toBe(current.digest);
    expect(staged.dir).toBe(join(tmp, "out"));
    expect(await readFile(join(tmp, "out", "references", "x.md"), "utf8")).toBe("ref");
    expect(existsSync(join(tmp, "out", "grimoire.bench.yaml"))).toBe(false);
    expect(existsSync(join(tmp, "out", "fixtures"))).toBe(false);
  });

  it("withSuite also copies the suite and fixtures without changing the digest", async () => {
    const current = await makeSkill();
    const staged = await stageCandidate(current, join(tmp, "out"), { withSuite: true });
    expect(staged.digest).toBe(current.digest);
    expect(await readFile(join(tmp, "out", "grimoire.bench.yaml"), "utf8")).toBe("suite: s");
    expect(await readFile(join(tmp, "out", "fixtures", "a.txt"), "utf8")).toBe("fx");
  });

  it("withSuite tolerates a skill that has no suite", async () => {
    const current = await makeSkill();
    await rm(join(current.dir, "grimoire.bench.yaml"));
    await rm(join(current.dir, "fixtures"), { recursive: true });
    const staged = await stageCandidate(current, join(tmp, "out"), { withSuite: true });
    expect(existsSync(join(staged.dir, "grimoire.bench.yaml"))).toBe(false);
    expect(existsSync(join(staged.dir, "fixtures"))).toBe(false);
  });

  it("rewrites an existing frontmatter version, leaving everything else byte-for-byte", async () => {
    const current = await makeSkill();
    const staged = await stageCandidate(current, join(tmp, "out"), { version: "1.1.0" });
    expect(staged.version).toBe("1.1.0");
    expect(staged.digest).not.toBe(current.digest);
    expect(await readFile(join(tmp, "out", "SKILL.md"), "utf8")).toBe(
      "---\nname: demo\ndescription: d\nversion: 1.1.0\n---\nBody\n",
    );
  });

  it("adds a version when the skill had none, and keeps CRLF line endings", async () => {
    const dir = join(tmp, "crlf");
    await mkdir(dir);
    await writeFile(
      join(dir, "SKILL.md"),
      "---\r\nname: crlf\r\ndescription: d\r\n---\r\nBody\r\n",
    );
    const current = await loadSkill(dir);
    const staged = await stageCandidate(current, join(tmp, "out"), { version: "0.2.0" });
    expect(staged.version).toBe("0.2.0");
    expect(await readFile(join(tmp, "out", "SKILL.md"), "utf8")).toBe(
      "---\r\nname: crlf\r\ndescription: d\r\nversion: 0.2.0\r\n---\r\nBody\r\n",
    );
  });

  it("rejects a version that is not semver", async () => {
    const current = await makeSkill();
    await expect(stageCandidate(current, join(tmp, "out"), { version: "latest" })).rejects.toThrow(
      /semver/,
    );
  });

  it("refuses a destination that already has files, and leaves the source untouched", async () => {
    const current = await makeSkill();
    await mkdir(join(tmp, "out"));
    await writeFile(join(tmp, "out", "keep.txt"), "x");
    await expect(stageCandidate(current, join(tmp, "out"))).rejects.toThrow(/not empty/);
    expect((await loadSkill(current.dir)).digest).toBe(current.digest);
  });

  it("accepts an existing empty destination", async () => {
    const current = await makeSkill();
    await mkdir(join(tmp, "out"));
    expect((await stageCandidate(current, join(tmp, "out"))).digest).toBe(current.digest);
  });
});

describe("proposeVersion", () => {
  const edit: SkillRewriter = async (_skill, _basis, outDir) => {
    await writeFile(
      join(outDir, "SKILL.md"),
      "---\nname: demo\ndescription: d\n---\nBetter body\n",
    );
    return { changelog: "tightened the body" };
  };

  it("stages, runs the rewriter on the staged dir, and returns dir, digest and changelog", async () => {
    const current = await makeSkill();
    const seen: unknown[] = [];
    const outDir = join(tmp, "out");
    const proposal = await proposeVersion(current, basis, {
      outDir,
      rewriter: async (skill, b, dir) => {
        seen.push(skill, b, dir);
        return edit(skill, b, dir);
      },
    });

    expect(seen).toEqual([current, basis, outDir]);
    expect(proposal).toMatchObject({ dir: outDir, changelog: "tightened the body" });
    expect(proposal.digest).toBe((await loadSkill(outDir)).digest);
    expect(proposal.digest).not.toBe(current.digest);
    expect(proposal.skill.digest).toBe(proposal.digest);
    // the original skill is untouched
    expect((await loadSkill(current.dir)).digest).toBe(current.digest);
  });

  it("stages into a fresh temp dir when no outDir is given", async () => {
    const current = await makeSkill();
    const proposal = await proposeVersion(current, basis, { rewriter: edit });
    try {
      expect(proposal.dir).not.toBe(current.dir);
      expect(await readFile(join(proposal.dir, "SKILL.md"), "utf8")).toContain("Better body");
    } finally {
      await rm(proposal.dir, { recursive: true, force: true });
    }
  });

  it("applies a version bump before the rewriter runs", async () => {
    const current = await makeSkill();
    const proposal = await proposeVersion(current, basis, {
      outDir: join(tmp, "out"),
      version: "1.1.0",
      rewriter: async (_s, _b, dir) => {
        await writeFile(join(dir, "references", "x.md"), "new ref");
        return { changelog: "c" };
      },
    });
    expect(proposal.skill.version).toBe("1.1.0");
  });

  it("throws RewriterNotAvailable without a rewriter, and does not touch the disk", async () => {
    const current = await makeSkill();
    const outDir = join(tmp, "out");
    const err = await proposeVersion(current, basis, { outDir }).catch((e) => e);
    expect(err).toBeInstanceOf(RewriterNotAvailable);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RewriterNotAvailable");
    expect(existsSync(outDir)).toBe(false);
    await expect(proposeVersion(current, basis)).rejects.toBeInstanceOf(RewriterNotAvailable);
  });

  it("throws NoChange when the rewriter leaves the content identical, and cleans its temp dir", async () => {
    const current = await makeSkill();
    const dirs: string[] = [];
    const err = await proposeVersion(current, basis, {
      rewriter: async (_s, _b, dir) => {
        dirs.push(dir);
        return { changelog: "nothing" };
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NoChange);
    expect(err.digest).toBe(current.digest);
    expect(existsSync(dirs[0] ?? "")).toBe(false);
  });

  it("treats a version bump alone as no change", async () => {
    const current = await makeSkill();
    await expect(
      proposeVersion(current, basis, {
        outDir: join(tmp, "out"),
        version: "1.1.0",
        rewriter: async () => ({ changelog: "nothing" }),
      }),
    ).rejects.toBeInstanceOf(NoChange);
  });

  it("propagates rewriter failures and leaves a caller-supplied outDir for inspection", async () => {
    const current = await makeSkill();
    const outDir = join(tmp, "out");
    await expect(
      proposeVersion(current, basis, {
        outDir,
        rewriter: async () => {
          throw new Error("llm down");
        },
      }),
    ).rejects.toThrow("llm down");
    expect(existsSync(join(outDir, "SKILL.md"))).toBe(true);
  });

  it("fails when the rewriter leaves an invalid skill", async () => {
    const current = await makeSkill();
    await expect(
      proposeVersion(current, basis, {
        rewriter: async (_s, _b, dir) => {
          await rm(join(dir, "SKILL.md"));
          return { changelog: "oops" };
        },
      }),
    ).rejects.toThrow(/No SKILL.md/);
  });
});
