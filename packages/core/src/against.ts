import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { loadSkill } from "./skill.js";
import type { Skill } from "./types.js";

export interface ResolvedAgainst {
  skill: Skill;
  /** Removes any files extracted from git; a no-op for plain directories. */
  cleanup(): Promise<void>;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function git(cwd: string, args: string[]) {
  return execa("git", args, { cwd, reject: false });
}

/** Exports the tree under `cwd` at `commit` into `dest`, without touching the work tree or index. */
async function exportTree(cwd: string, commit: string, dest: string): Promise<number> {
  const ls = await execa("git", ["ls-tree", "-r", "-z", commit, "--", "."], { cwd });
  const entries = String(ls.stdout).split("\0").filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [mode, , sha] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(
        `${path} at ${commit.slice(0, 10)} is a symlink or submodule; not supported in a skill`,
      );
    }
    // stripFinalNewline would drop a trailing newline from the file and change its digest.
    const blob = await execa("git", ["cat-file", "blob", sha ?? ""], {
      cwd,
      encoding: "buffer",
      stripFinalNewline: false,
    });
    const file = join(dest, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, blob.stdout);
  }
  return entries.length;
}

/**
 * Resolves the `--against` argument to a skill. Tried in order: an existing directory; a tag
 * `<skill>@<arg>` when `arg` is a semver; any git ref (branch, tag, commit, HEAD~1). Git sources
 * are read from the repository containing `current`, at the same relative path.
 */
export async function resolveAgainst(current: Skill, arg: string): Promise<ResolvedAgainst> {
  const isDir = await stat(arg).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (isDir) return { skill: await loadSkill(arg), cleanup: async () => {} };

  const prefix = await git(current.dir, ["rev-parse", "--show-prefix"]);
  if (prefix.failed) {
    throw new Error(
      `"${arg}" is not a directory, and ${current.dir} is not inside a git repository`,
    );
  }

  const candidates = SEMVER.test(arg) ? [`${current.name}@${arg}`, arg] : [arg];
  let commit: string | undefined;
  for (const c of candidates) {
    const r = await git(current.dir, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`]);
    if (!r.failed) {
      commit = String(r.stdout).trim();
      break;
    }
  }
  if (!commit) {
    throw new Error(
      `Cannot resolve "${arg}" as a directory, a git ref${SEMVER.test(arg) ? ` or tag ${candidates[0]}` : ""}`,
    );
  }

  const root = await mkdtemp(join(tmpdir(), "grimoire-against-"));
  const dest = join(root, "skill");
  const cleanup = () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    await mkdir(dest);
    const count = await exportTree(current.dir, commit, dest);
    if (count === 0) {
      throw new Error(`${prefix.stdout || "."} does not exist at ${arg} (${commit.slice(0, 10)})`);
    }
    return { skill: await loadSkill(dest), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
