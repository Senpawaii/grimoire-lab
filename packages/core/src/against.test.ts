import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgainst } from "./against.js";
import { loadSkill } from "./skill.js";

let repo: string;
let skillDir: string;

const git = (...args: string[]) =>
  execa(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: repo,
    },
  );

const skillMd = (version: string, body: string) =>
  `---\nname: demo\ndescription: d\nversion: ${version}\n---\n${body}\n`;

async function commit(message: string) {
  await git("add", "-A");
  await git("commit", "-q", "-m", message);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "against-test-"));
  skillDir = join(repo, "skills", "demo");
  await mkdir(join(skillDir, "scripts"), { recursive: true });
  await git("init", "-q");
  await writeFile(join(skillDir, "SKILL.md"), skillMd("1.0.0", "first"));
  await writeFile(join(skillDir, "scripts", "run.sh"), "echo 1\n");
  await writeFile(join(skillDir, "grimoire.bench.yaml"), "suite: s\n");
  await commit("v1");
  await git("tag", "demo@1.0.0");

  await writeFile(join(skillDir, "SKILL.md"), skillMd("1.1.0", "second"));
  await commit("v1.1");
});
afterEach(() => rm(repo, { recursive: true, force: true }));

describe("resolveAgainst", () => {
  it("uses an existing directory as is, without cleanup side effects", async () => {
    const other = join(repo, "other");
    await mkdir(other);
    await writeFile(join(other, "SKILL.md"), skillMd("9.9.9", "x"));
    const current = await loadSkill(skillDir);

    const r = await resolveAgainst(current, other);

    expect(r.skill.version).toBe("9.9.9");
    await r.cleanup();
    expect(existsSync(other)).toBe(true);
  });

  it("reads the skill at a git ref from the same relative path, with all files", async () => {
    const current = await loadSkill(skillDir);
    const r = await resolveAgainst(current, "HEAD~1");
    try {
      expect(r.skill.version).toBe("1.0.0");
      expect(await readFile(join(r.skill.dir, "SKILL.md"), "utf8")).toContain("first");
      expect(await readFile(join(r.skill.dir, "scripts", "run.sh"), "utf8")).toBe("echo 1\n");
      expect(r.skill.digest).not.toBe(current.digest);
    } finally {
      await r.cleanup();
    }
    expect(existsSync(r.skill.dir)).toBe(false);
  });

  it("resolves a bare semver to the tag <skill>@<semver>", async () => {
    const r = await resolveAgainst(await loadSkill(skillDir), "1.0.0");
    try {
      expect(r.skill.version).toBe("1.0.0");
    } finally {
      await r.cleanup();
    }
  });

  it("ignores uncommitted edits in the working tree when reading a ref", async () => {
    await writeFile(join(skillDir, "SKILL.md"), skillMd("2.0.0", "dirty"));
    const current = await loadSkill(skillDir);
    const r = await resolveAgainst(current, "HEAD");
    try {
      expect(r.skill.version).toBe("1.1.0");
      expect(current.version).toBe("2.0.0");
    } finally {
      await r.cleanup();
    }
  });

  it("falls back to a ref named like a semver when no <skill>@<semver> tag exists", async () => {
    await git("tag", "2.5.0", "HEAD~1");
    const r = await resolveAgainst(await loadSkill(skillDir), "2.5.0");
    try {
      expect(r.skill.version).toBe("1.0.0");
    } finally {
      await r.cleanup();
    }
  });

  it("fails clearly for an unknown ref, naming the tag it tried for semvers", async () => {
    const current = await loadSkill(skillDir);
    await expect(resolveAgainst(current, "nope")).rejects.toThrow(/Cannot resolve "nope"/);
    await expect(resolveAgainst(current, "7.7.7")).rejects.toThrow(/tag demo@7\.7\.7/);
  });

  it("fails when the skill directory did not exist at that ref", async () => {
    const fresh = join(repo, "skills", "fresh");
    await mkdir(fresh);
    await writeFile(join(fresh, "SKILL.md"), skillMd("1.0.0", "new"));
    await commit("add fresh");
    const current = await loadSkill(fresh);
    await expect(resolveAgainst(current, "HEAD~1")).rejects.toThrow(/does not exist at HEAD~1/);
  });

  it("fails when the path is neither a directory nor inside a git repository", async () => {
    const lonely = await mkdtemp(join(tmpdir(), "no-git-"));
    try {
      await writeFile(join(lonely, "SKILL.md"), skillMd("1.0.0", "x"));
      await expect(resolveAgainst(await loadSkill(lonely), "main")).rejects.toThrow(
        /not inside a git repository/,
      );
    } finally {
      await rm(lonely, { recursive: true, force: true });
    }
  });

  // Creating symlinks needs elevated rights on Windows.
  it.skipIf(process.platform === "win32")(
    "rejects symlinks in the exported tree instead of writing them as files",
    async () => {
      await symlink("SKILL.md", join(skillDir, "link.md"));
      await commit("add symlink");
      await expect(resolveAgainst(await loadSkill(skillDir), "HEAD")).rejects.toThrow(
        /symlink or submodule/,
      );
    },
  );
});
