import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listSkillFiles } from "./digest.js";
import type { BenchResult } from "./result.js";
import { loadSkill } from "./skill.js";
import type { Skill } from "./types.js";

/** `proposeVersion` was called without a rewriter. Core generates no skill content itself. */
export class RewriterNotAvailable extends Error {
  override name = "RewriterNotAvailable";
  constructor() {
    super(
      "No skill rewriter configured: pass `rewriter` to proposeVersion. grimoire-lab does not generate skill content itself.",
    );
  }
}

/** The rewriter left the staged skill with the same content as before. */
export class NoChange extends Error {
  override name = "NoChange";
  constructor(
    /** Digest of the unchanged skill. */
    readonly digest: string,
  ) {
    super(`The rewriter did not change the skill (${digest.slice(0, 19)}); there is no proposal`);
  }
}

/**
 * Edits the skill staged in `outDir` (a copy of `skill`, ready to modify in place) using what the
 * benchmark in `basis` measured, and describes the change. It may be an LLM-driven agent, a
 * human-in-the-loop script, anything. It must not touch `skill.dir`.
 */
export type SkillRewriter = (
  skill: Skill,
  basis: BenchResult,
  outDir: string,
) => Promise<{ changelog: string }>;

export interface StageOptions {
  /** Rewrites the frontmatter `version` (added when absent). Must be semver. */
  version?: string;
  /**
   * Also copies the current skill's benchmark suite (`grimoire.bench.yaml` and `fixtures/`) so the
   * staged directory can be benchmarked or promoted as a complete skill folder. They are not part of
   * the digest, so this never changes the staged digest.
   */
  withSuite?: boolean;
}

const FRONTMATTER = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

function withVersion(source: string, version: string): string {
  const m = FRONTMATTER.exec(source);
  if (!m) throw new Error("SKILL.md must start with a YAML frontmatter block delimited by ---");
  const [whole, open = "", yaml = "", close = ""] = m;
  const eol = open.endsWith("\r\n") ? "\r\n" : "\n";
  const line = `version: ${version}`;
  const next = /^version[ \t]*:.*$/m.test(yaml)
    ? yaml.replace(/^version[ \t]*:.*$/m, line)
    : `${yaml}${eol}${line}`;
  return `${open}${next}${close}${source.slice(whole.length)}`;
}

/**
 * Copies the skill's files to `destDir` (which must not exist or be empty) and returns the staged
 * skill. Files are selected exactly like the digest does, so benchmark inputs (`grimoire.bench.yaml`,
 * `fixtures/`) and `.git` are not copied, and without `version` the staged digest equals
 * `current.digest`. Whoever edits (a human or an agent) edits `destDir` afterwards; core does not
 * generate content. The suite stays with the current skill unless `withSuite` is set.
 */
export async function stageCandidate(
  current: Skill,
  destDir: string,
  opts: StageOptions = {},
): Promise<Skill> {
  const dest = resolve(destDir);
  const existing = await readdir(dest).catch(() => undefined);
  if (existing && existing.length > 0) throw new Error(`${dest} already exists and is not empty`);

  for (const rel of await listSkillFiles(current.dir)) {
    const target = join(dest, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(current.dir, rel), target);
  }
  if (opts.withSuite) {
    for (const name of ["grimoire.bench.yaml", "fixtures"]) {
      await cp(join(current.dir, name), join(dest, name), { recursive: true }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
    }
  }
  if (opts.version !== undefined) {
    const file = join(dest, "SKILL.md");
    await writeFile(file, withVersion(await readFile(file, "utf8"), opts.version));
  }
  return loadSkill(dest);
}

export interface ProposeOptions {
  /** Required: there is no default content generator. */
  rewriter?: SkillRewriter;
  /**
   * Where to stage the candidate (must not exist or be empty). Default: a fresh directory under
   * the OS temp dir, which the caller owns and removes.
   */
  outDir?: string;
  /** Bump the staged skill's frontmatter `version` before the rewriter runs. */
  version?: string;
}

export interface Proposal {
  /** The staged candidate directory, loadable with `loadSkill`. */
  dir: string;
  /** Identity of the candidate; always differs from the unchanged staged copy. */
  digest: string;
  /** From the rewriter. */
  changelog: string;
  skill: Skill;
}

/**
 * Proposes a new version of `skill` from the measurements in `basis`: stages a copy, runs the
 * injected `rewriter` on it, and loads the result.
 *
 * - No rewriter: throws `RewriterNotAvailable` before touching the disk. Never a stub.
 * - Rewriter leaves the content unchanged (compared with the staged copy, so a `version` bump
 *   alone is not a change): throws `NoChange`.
 * - Rewriter throws, or the result is not a valid skill: the error propagates. A temp dir that
 *   this function created is removed; a caller-supplied `outDir` is left for inspection.
 *
 * To measure a proposal, benchmark `proposal.skill` against `skill` as version-vs-version and
 * apply your own promotion policy; core never writes into the current skill's source.
 */
export async function proposeVersion(
  skill: Skill,
  basis: BenchResult,
  opts: ProposeOptions = {},
): Promise<Proposal> {
  const { rewriter } = opts;
  if (!rewriter) throw new RewriterNotAvailable();

  const ownsDir = opts.outDir === undefined;
  const dir = opts.outDir ?? (await mkdtemp(join(tmpdir(), "grimoire-propose-")));
  try {
    const staged = await stageCandidate(skill, dir, { version: opts.version });
    const { changelog } = await rewriter(skill, basis, dir);
    const candidate = await loadSkill(dir);
    if (candidate.digest === staged.digest) throw new NoChange(candidate.digest);
    return { dir: candidate.dir, digest: candidate.digest, changelog, skill: candidate };
  } catch (err) {
    if (ownsDir) await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
