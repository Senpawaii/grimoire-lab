import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestDir } from "./digest.js";
import {
  AmbiguousSkill,
  DigestMismatch,
  dirSource,
  gitSource,
  listSkills,
  load,
  loadSkillByDigest,
  resolve,
  resolveSkill,
  SkillNotFound,
  type SkillSource,
} from "./sources.js";

let tmp: string;

const skillMd = (name: string, version: string | undefined, body: string) =>
  `---\nname: ${name}\ndescription: ${name} desc\n${version ? `version: ${version}\n` : ""}---\n${body}\n`;

async function writeSkill(root: string, name: string, version: string | undefined, body: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd(name, version, body));
  return dir;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sources-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe("dirSource", () => {
  it("lists skills with digests, ignores non-skill folders", async () => {
    const root = join(tmp, "skills");
    const a = await writeSkill(root, "alpha", "1.0.0", "a");
    await mkdir(join(root, "junk"), { recursive: true });
    const src = dirSource(root, { id: "local" });
    const list = await src.list();
    expect(list).toEqual([
      {
        name: "alpha",
        description: "alpha desc",
        version: "1.0.0",
        digest: await digestDir(a),
        source: "local",
        current: true,
      },
    ]);
  });

  it("returns [] for a missing directory", async () => {
    expect(await dirSource(join(tmp, "nope")).list()).toEqual([]);
  });

  it("sees in-place edits and removals despite the per-instance cache", async () => {
    const root = join(tmp, "skills");
    const a = await writeSkill(root, "alpha", undefined, "one");
    const src = dirSource(root);
    const [first] = await src.list();
    // The index is reused while nothing changed.
    expect((await src.list())[0]?.digest).toBe(first?.digest);
    await writeFile(join(a, "SKILL.md"), skillMd("alpha", undefined, "two!"));
    await utimes(join(a, "SKILL.md"), new Date(), new Date(Date.now() + 5000));
    const [second] = await src.list();
    expect(second?.digest).not.toBe(first?.digest);
    await rm(a, { recursive: true });
    expect(await src.list()).toEqual([]);
  });

  it("loads in place with a no-op dispose", async () => {
    const root = join(tmp, "skills");
    const a = await writeSkill(root, "alpha", undefined, "one");
    const src = dirSource(root);
    const digest = await digestDir(a);
    const loaded = await src.load(digest);
    expect(loaded?.skill.dir).toBe(a);
    await loaded?.dispose();
    expect(existsSync(a)).toBe(true);
    expect(await src.load("sha256:nope")).toBeUndefined();
  });
});

describe("resolveSkill / loadSkillByDigest", () => {
  it("resolves every grammar form", async () => {
    const a = await writeSkill(join(tmp, "s"), "alpha", "1.0.0", "a");
    const digest = await digestDir(a);
    const srcs = [dirSource(join(tmp, "s"), { id: "s" })];
    const want = { name: "alpha", version: "1.0.0", digest, source: "s" };
    expect(await resolveSkill("alpha", srcs)).toEqual(want);
    expect(await resolveSkill("alpha@1.0.0", srcs)).toEqual(want);
    expect(await resolveSkill(`alpha@${digest}`, srcs)).toEqual(want);
    expect(await resolveSkill(digest, srcs)).toEqual(want);
    expect(await resolve("alpha", srcs)).toBe(digest);
  });

  it("throws SkillNotFound for unknown or malformed refs", async () => {
    await writeSkill(join(tmp, "s"), "alpha", "1.0.0", "a");
    const srcs = [dirSource(join(tmp, "s"))];
    await expect(resolveSkill("beta", srcs)).rejects.toBeInstanceOf(SkillNotFound);
    await expect(resolveSkill("alpha@2.0.0", srcs)).rejects.toBeInstanceOf(SkillNotFound);
    await expect(resolveSkill("alpha@", srcs)).rejects.toBeInstanceOf(SkillNotFound);
    await expect(resolveSkill("sha256:abc", srcs)).rejects.toBeInstanceOf(SkillNotFound);
  });

  it("throws AmbiguousSkill when sources disagree, never first-match", async () => {
    await writeSkill(join(tmp, "one"), "alpha", "1.0.0", "a");
    await writeSkill(join(tmp, "two"), "alpha", "1.0.0", "different");
    const srcs = [
      dirSource(join(tmp, "one"), { id: "one" }),
      dirSource(join(tmp, "two"), { id: "two" }),
    ];
    const err = await resolveSkill("alpha", srcs).catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousSkill);
    expect((err as AmbiguousSkill).candidates.map((c) => c.source)).toEqual(["one", "two"]);
    await expect(resolveSkill("alpha@1.0.0", srcs)).rejects.toBeInstanceOf(AmbiguousSkill);
    // A digest is never ambiguous.
    const pinned = (err as AmbiguousSkill).candidates[1]?.digest ?? "";
    expect((await resolveSkill(pinned, srcs)).source).toBe("two");
  });

  it("does not treat identical content in two sources as ambiguous", async () => {
    await writeSkill(join(tmp, "one"), "alpha", "1.0.0", "same");
    await writeSkill(join(tmp, "two"), "alpha", "1.0.0", "same");
    const srcs = [
      dirSource(join(tmp, "one"), { id: "one" }),
      dirSource(join(tmp, "two"), { id: "two" }),
    ];
    expect((await resolveSkill("alpha", srcs)).source).toBe("one");
  });

  it("throws DigestMismatch (typed, with expected/actual) when a source returns other content", async () => {
    const a = await writeSkill(join(tmp, "s"), "alpha", undefined, "a");
    const actual = await digestDir(a);
    const expected = `sha256:${"0".repeat(64)}`;
    let disposed = false;
    const liar: SkillSource = {
      id: "liar",
      list: async () => [],
      load: async () => ({
        skill: { dir: a, name: "alpha", description: "d", digest: expected },
        dispose: async () => {
          disposed = true;
        },
      }),
    };
    const err = await loadSkillByDigest(expected, [liar]).catch((e) => e);
    expect(err).toBeInstanceOf(DigestMismatch);
    expect(err.expected).toBe(expected);
    expect(err.actual).toBe(actual);
    expect(disposed).toBe(true);
  });

  it("loadSkillByDigest throws SkillNotFound when no source has it", async () => {
    await expect(loadSkillByDigest("sha256:x", [dirSource(tmp)])).rejects.toBeInstanceOf(
      SkillNotFound,
    );
  });
});

describe("onSourceError", () => {
  const boom = new Error("remote down");
  const failing: SkillSource = {
    id: "failing",
    list: () => Promise.reject(boom),
    load: () => Promise.reject(boom),
  };

  it("without the option the first source error is rethrown", async () => {
    const good = dirSource(join(tmp, "good"));
    await writeSkill(join(tmp, "good"), "alpha", "1.0.0", "a");
    await expect(resolveSkill("alpha", [failing, good])).rejects.toBe(boom);
    await expect(listSkills([failing, good])).rejects.toBe(boom);
    await expect(loadSkillByDigest("sha256:x", [failing, good])).rejects.toBe(boom);
  });

  it("with the option a failing source is skipped, reported, and the others still answer", async () => {
    const dir = await writeSkill(join(tmp, "good"), "alpha", "1.0.0", "a");
    const good = dirSource(join(tmp, "good"), { id: "good" });
    const digest = await digestDir(dir);
    const seen: [unknown, string][] = [];
    const opts = { onSourceError: (e: unknown, s: SkillSource) => seen.push([e, s.id]) };

    expect((await resolveSkill("alpha", [failing, good], opts)).digest).toBe(digest);
    expect((await listSkills([failing, good], opts)).map((r) => r.name)).toEqual(["alpha"]);
    const loaded = await loadSkillByDigest(digest, [failing, good], opts);
    expect(loaded.skill.name).toBe("alpha");
    await loaded.dispose();
    expect((await resolve("alpha", [failing, good], opts)) === digest).toBe(true);
    expect(seen.length).toBe(4);
    expect(seen.every(([e, id]) => e === boom && id === "failing")).toBe(true);
  });

  it("still throws SkillNotFound when every source fails", async () => {
    await expect(
      resolveSkill("alpha", [failing], { onSourceError: () => {} }),
    ).rejects.toBeInstanceOf(SkillNotFound);
  });
});

describe("listSkills / load", () => {
  it("lists across sources with the source id", async () => {
    await writeSkill(join(tmp, "one"), "alpha", "1.0.0", "a");
    await writeSkill(join(tmp, "two"), "beta", undefined, "b");
    const rows = await listSkills([
      dirSource(join(tmp, "one"), { id: "one" }),
      dirSource(join(tmp, "two"), { id: "two" }),
    ]);
    expect(rows.map((r) => [r.name, r.source, r.version])).toEqual([
      ["alpha", "one", "1.0.0"],
      ["beta", "two", undefined],
    ]);
    expect(rows[1]).not.toHaveProperty("version");
  });

  it("loads {name, digest}, and throws DigestMismatch after an on-disk edit", async () => {
    const root = join(tmp, "s");
    const a = await writeSkill(root, "alpha", undefined, "one");
    const srcs = [dirSource(root, { id: "s" })];
    const digest = await resolve("alpha", srcs);
    const ok = await load({ name: "alpha", digest }, srcs);
    expect(ok.skill.digest).toBe(digest);
    await ok.dispose();

    await writeFile(join(a, "SKILL.md"), skillMd("alpha", undefined, "edited"));
    const err = await load({ name: "alpha", digest }, srcs).catch((e) => e);
    expect(err).toBeInstanceOf(DigestMismatch);
    expect(err.expected).toBe(digest);
    expect(err.actual).toBe(await digestDir(a));
  });

  it("throws SkillNotFound for an unknown name, or a digest belonging to another name", async () => {
    const root = join(tmp, "s");
    const a = await writeSkill(root, "alpha", undefined, "one");
    await writeSkill(root, "beta", undefined, "two");
    const srcs = [dirSource(root)];
    const digest = await digestDir(a);
    await expect(load({ name: "gamma", digest: "sha256:x" }, srcs)).rejects.toBeInstanceOf(
      SkillNotFound,
    );
    await expect(load({ name: "beta", digest }, srcs)).rejects.toBeInstanceOf(SkillNotFound);
  });
});

describe("gitSource", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execa(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: repo,
      },
    );
  const commit = async (msg: string) => {
    await git("add", "-A");
    await git("commit", "-q", "-m", msg);
  };

  beforeEach(async () => {
    repo = join(tmp, "repo");
    await mkdir(repo);
    await git("init", "-q");
    await writeSkill(join(repo, "skills"), "demo", "1.0.0", "first");
    await writeFile(join(repo, "skills", "demo", "grimoire.bench.yaml"), "suite: s\n");
    await commit("v1");
    await git("tag", "demo@1.0.0");
    await writeSkill(join(repo, "skills"), "demo", "1.1.0", "second");
    await writeSkill(join(repo, "skills"), "other", undefined, "o");
    await commit("v1.1");
  });

  it("lists HEAD (current) and tagged versions", async () => {
    const list = await gitSource({ repo, path: "skills", id: "g" }).list();
    expect(list.map((l) => [l.name, l.version, l.current]).sort()).toEqual([
      ["demo", "1.0.0", false],
      ["demo", "1.1.0", true],
      ["other", undefined, true],
    ]);
  });

  it("resolves bare name to HEAD and name@version to the tag, leaving the work tree alone", async () => {
    const srcs = [gitSource({ repo, path: "skills", id: "g" })];
    const head = await resolveSkill("demo", srcs);
    expect(head.version).toBe("1.1.0");
    const old = await resolveSkill("demo@1.0.0", srcs);
    expect(old.digest).not.toBe(head.digest);

    const loaded = await loadSkillByDigest(old.digest, srcs);
    expect(loaded.skill.version).toBe("1.0.0");
    expect(loaded.skill.digest).toBe(old.digest);
    expect(existsSync(join(loaded.skill.dir, "SKILL.md"))).toBe(true);
    await loaded.dispose();
  });

  it("dispose removes the exported temp dir", async () => {
    const srcs = [gitSource({ repo, path: "skills" })];
    const { digest } = await resolveSkill("demo", srcs);
    const loaded = await loadSkillByDigest(digest, srcs);
    expect(existsSync(loaded.skill.dir)).toBe(true);
    await loaded.dispose();
    expect(existsSync(loaded.skill.dir)).toBe(false);
  });

  it("ignores uncommitted edits and picks up a new commit", async () => {
    const src = gitSource({ repo, path: "skills" });
    const before = await resolveSkill("other", [src]);
    await writeFile(
      join(repo, "skills", "other", "SKILL.md"),
      skillMd("other", undefined, "dirty"),
    );
    expect((await resolveSkill("other", [src])).digest).toBe(before.digest);
    await commit("o2");
    expect((await resolveSkill("other", [src])).digest).not.toBe(before.digest);
  });

  it("an old digest from a moved HEAD stays loadable through its tag", async () => {
    const src = gitSource({ repo, path: "skills" });
    const old = await resolveSkill("demo@1.0.0", [src]);
    await writeSkill(join(repo, "skills"), "demo", "1.2.0", "third");
    await commit("v1.2");
    const loaded = await load({ name: "demo", digest: old.digest }, [src]);
    expect(loaded.skill.version).toBe("1.0.0");
    await loaded.dispose();
  });

  it("an unrelated commit keeps tagged versions listed with unchanged digests", async () => {
    const src = gitSource({ repo, path: "skills" });
    const tagged = (await src.list()).find((l) => l.version === "1.0.0");
    await writeSkill(join(repo, "skills"), "other", undefined, "changed");
    await commit("unrelated");
    const after = await src.list();
    expect(after.find((l) => l.version === "1.0.0")?.digest).toBe(tagged?.digest);
    expect(after.filter((l) => l.name === "demo")).toHaveLength(2);
  });

  it("mixes with a dirSource: same name, different content is ambiguous", async () => {
    await writeSkill(join(tmp, "local"), "demo", "1.1.0", "local edit");
    const srcs = [
      dirSource(join(tmp, "local"), { id: "local" }),
      gitSource({ repo, path: "skills", id: "g" }),
    ];
    await expect(resolveSkill("demo", srcs)).rejects.toBeInstanceOf(AmbiguousSkill);
  });

  it("returns [] for a repo without commits or a missing path", async () => {
    const empty = join(tmp, "empty");
    await mkdir(empty);
    await execa("git", ["init", "-q"], { cwd: empty });
    expect(await gitSource({ repo: empty }).list()).toEqual([]);
    expect(await gitSource({ repo, path: "nope" }).list()).toEqual([]);
  });
});
