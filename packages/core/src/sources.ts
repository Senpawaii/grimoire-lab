import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execa } from "execa";
import { exportTree, SEMVER } from "./against.js";
import { digestDir } from "./digest.js";
import { loadSkill } from "./skill.js";
import type { Skill } from "./types.js";

/** A pinned skill: the digest is the identity; name and version are labels. */
export interface SkillRef {
  name: string;
  version?: string;
  digest: string;
  /** Id of the `SkillSource` the ref was resolved from. */
  source?: string;
}

/** A skill materialized on disk. `dispose` removes temp files created for git/remote sources. */
export interface LoadedSkill {
  skill: Skill;
  dispose(): Promise<void>;
}

/** One entry of `SkillSource.list`. */
export type SkillListing = SkillRef & {
  description: string;
  /**
   * True for what the source holds now (directory contents, git HEAD). False for historical
   * versions (git tags). A bare `name` ref only matches current entries.
   */
  current?: boolean;
};

/** Read-only store of skills. Heartwood can implement this for its own stores. */
export interface SkillSource {
  id: string;
  list(): Promise<SkillListing[]>;
  /** `undefined` = this source does not hold that digest. */
  load(digest: string): Promise<LoadedSkill | undefined>;
}

export class SkillNotFound extends Error {
  constructor(readonly ref: string) {
    super(`Skill not found: ${ref}`);
    this.name = "SkillNotFound";
  }
}

export class AmbiguousSkill extends Error {
  constructor(
    readonly ref: string,
    readonly candidates: SkillRef[],
  ) {
    super(
      `Ambiguous skill reference "${ref}": ${candidates
        .map((c) => `${c.name}${c.version ? `@${c.version}` : ""} ${c.digest} (${c.source})`)
        .join(", ")}. Pin it with a digest.`,
    );
    this.name = "AmbiguousSkill";
  }
}

export class DigestMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly skill?: string,
  ) {
    super(
      `Digest mismatch${skill ? ` for skill "${skill}"` : ""}: expected ${expected}, got ${actual}`,
    );
    this.name = "DigestMismatch";
  }
}

const noop = async () => {};

const removeDir = (dir: string) =>
  rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/**
 * A directory of skill folders (`grimoire/skills`, `.claude/skills`, ...). `list` re-reads the
 * directory every call, but re-hashes a skill only when a file's path, size or mtime in it
 * changed (an in-place edit changes the file mtime, not the directory's, so a stat of every
 * file is the cheapest correct invalidation). Skills that fail to parse are skipped.
 * `load` returns the folder in place; `dispose` is a no-op.
 */
export function dirSource(path: string, opts: { id?: string } = {}): SkillSource {
  const root = resolvePath(path);
  const id = opts.id ?? root;
  const cache = new Map<string, { sig: string; skill: Skill }>();

  async function signature(dir: string): Promise<string> {
    const parts: string[] = [];
    const walk = async (d: string, rel: string): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p, `${rel}${e.name}/`);
        else {
          const s = await stat(p);
          parts.push(`${rel}${e.name}:${s.size}:${s.mtimeMs}`);
        }
      }
    };
    await walk(dir, "");
    return parts.join("|");
  }

  async function skills(): Promise<Skill[]> {
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    const out: Skill[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const dir = join(root, name);
      const sig = await signature(dir);
      seen.add(dir);
      let hit = cache.get(dir);
      if (!hit || hit.sig !== sig) {
        try {
          hit = { sig, skill: await loadSkill(dir) };
        } catch {
          cache.delete(dir);
          continue;
        }
        cache.set(dir, hit);
      }
      out.push(hit.skill);
    }
    for (const dir of cache.keys()) if (!seen.has(dir)) cache.delete(dir);
    return out;
  }

  return {
    id,
    async list() {
      return (await skills()).map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        digest: s.digest,
        source: id,
        current: true,
      }));
    },
    async load(digest) {
      const hit = (await skills()).find((s) => s.digest === digest);
      if (!hit) return undefined;
      // Re-read from disk: the cached copy may predate an edit within one mtime tick.
      return { skill: await loadSkill(hit.dir), dispose: noop };
    },
  };
}

interface GitEntry {
  listing: SkillListing;
  commit: string;
  subdir: string;
}

/**
 * A local git repository (callers clone remotes first). `path` is the directory holding skill
 * folders, relative to `repo` (default: the repo root itself). `list` returns the skills at HEAD
 * (current) and one entry per `name@semver` tag whose tree holds `<path>/<name>`, deduplicated
 * by digest. Tagged skills are read from the folder named like the tag's skill, so keep folder
 * name and skill name equal. `load` exports the tree to a temp dir; `dispose` removes it.
 * The index is cached until HEAD or the tag set changes.
 */
export function gitSource(o: { repo: string; path?: string; id?: string }): SkillSource {
  const repo = resolvePath(o.repo);
  const base = (o.path ?? "").replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
  const id = o.id ?? repo;
  const sub = (name: string) => (base ? `${base}/${name}` : name);
  let cached: { key: string; entries: GitEntry[] } | undefined;

  const git = (args: string[]) => execa("git", args, { cwd: repo, reject: false });

  async function materialize(entry: GitEntry): Promise<LoadedSkill> {
    const root = await mkdtemp(join(tmpdir(), "grimoire-source-"));
    const dest = join(root, entry.listing.name);
    try {
      await mkdir(dest);
      await exportTree(repo, entry.commit, dest, entry.subdir);
      return { skill: await loadSkill(dest), dispose: () => removeDir(root) };
    } catch (err) {
      await removeDir(root);
      throw err;
    }
  }

  async function tryMaterialize(entry: GitEntry): Promise<LoadedSkill | undefined> {
    try {
      return await materialize(entry);
    } catch {
      return undefined; // not a (valid) skill at that commit
    }
  }

  async function index(): Promise<GitEntry[]> {
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const tags = await git([
      "for-each-ref",
      "refs/tags",
      "--format=%(refname:short)\t%(objectname)\t%(*objectname)",
    ]);
    if (tags.failed && head.failed) return [];
    const headSha = head.failed ? "" : String(head.stdout).trim();
    const tagLines = tags.failed ? [] : String(tags.stdout).split("\n").filter(Boolean);
    const key = `${headSha}\n${tagLines.join("\n")}`;
    if (cached?.key === key) return cached.entries;

    const entries: GitEntry[] = [];
    const byKey = new Map<string, GitEntry>();
    const add = (e: GitEntry) => {
      const k = `${e.listing.name}\0${e.listing.digest}`;
      if (!byKey.has(k)) {
        byKey.set(k, e);
        entries.push(e);
      }
    };
    const addFrom = async (commit: string, name: string, version?: string, current?: boolean) => {
      const entry: GitEntry = {
        commit,
        subdir: sub(name),
        listing: { name, description: "", digest: "", source: id },
      };
      const loaded = await tryMaterialize(entry);
      if (!loaded) return;
      try {
        const { skill } = loaded;
        add({
          commit,
          subdir: entry.subdir,
          listing: {
            name: skill.name,
            description: skill.description,
            version: current ? skill.version : (version ?? skill.version),
            digest: skill.digest,
            source: id,
            current,
          },
        });
      } finally {
        await loaded.dispose();
      }
    };

    if (headSha) {
      const ls = await git(["ls-tree", "-d", "-z", "--name-only", `HEAD:./${base}`]);
      if (!ls.failed) {
        for (const name of String(ls.stdout).split("\0").filter(Boolean)) {
          await addFrom(headSha, name, undefined, true);
        }
      }
    }
    for (const line of tagLines) {
      const [ref = "", obj = "", peeled = ""] = line.split("\t");
      const at = ref.lastIndexOf("@");
      if (at <= 0) continue;
      const version = ref.slice(at + 1);
      if (!SEMVER.test(version)) continue;
      await addFrom(peeled || obj, ref.slice(0, at), version, false);
    }
    cached = { key, entries };
    return entries;
  }

  return {
    id,
    async list() {
      return (await index()).map((e) => ({ ...e.listing }));
    },
    async load(digest) {
      const entry = (await index()).find((e) => e.listing.digest === digest);
      return entry ? materialize(entry) : undefined;
    },
  };
}

const DIGEST_PREFIX = "sha256:";

function describeRef(l: SkillListing): SkillRef {
  return { name: l.name, version: l.version, digest: l.digest, source: l.source };
}

/**
 * Pins a loose reference to an exact digest. Grammar: `name | name@1.2.0 | name@sha256:<hex> |
 * sha256:<hex>`. A bare `name` matches the current entries of every source (directory contents,
 * git HEAD); `name@version` also matches tagged versions. The same content in several sources
 * is not ambiguous (the first source in order is reported); different digests are, and throw
 * `AmbiguousSkill` rather than picking the first match.
 */
export async function resolveSkill(ref: string, sources: SkillSource[]): Promise<SkillRef> {
  let name: string | undefined;
  let version: string | undefined;
  let digest: string | undefined;
  if (ref.startsWith(DIGEST_PREFIX)) digest = ref;
  else {
    const at = ref.indexOf("@");
    if (at < 0) name = ref;
    else {
      name = ref.slice(0, at);
      const rest = ref.slice(at + 1);
      if (rest.startsWith(DIGEST_PREFIX)) digest = rest;
      else version = rest;
    }
    if (!name || (at >= 0 && !(digest ?? version))) {
      throw new SkillNotFound(ref);
    }
  }

  const matches: SkillListing[] = [];
  for (const source of sources) {
    for (const l of await source.list()) {
      if (name !== undefined && l.name !== name) continue;
      if (digest !== undefined && l.digest !== digest) continue;
      if (version !== undefined && l.version !== version) continue;
      if (digest === undefined && version === undefined && l.current === false) continue;
      matches.push(l);
    }
  }
  if (matches.length === 0) throw new SkillNotFound(ref);

  // Same name + digest across sources is the same content: collapse, keep first source.
  const distinct = new Map<string, SkillListing>();
  for (const m of matches) {
    const k = `${m.name}\0${m.digest}`;
    if (!distinct.has(k)) distinct.set(k, m);
  }
  if (distinct.size > 1) throw new AmbiguousSkill(ref, [...distinct.values()].map(describeRef));
  return describeRef(matches[0] as SkillListing);
}

/**
 * Loads the content with exactly this digest. The digest is re-computed after materializing;
 * a difference throws `DigestMismatch` (and disposes the files), so a pinned digest yields
 * exactly that content or fails. Throws `SkillNotFound` when no source holds the digest.
 */
export async function loadSkillByDigest(
  digest: string,
  sources: SkillSource[],
): Promise<LoadedSkill> {
  for (const source of sources) {
    const loaded = await source.load(digest);
    if (!loaded) continue;
    let actual: string;
    try {
      actual = await digestDir(loaded.skill.dir);
    } catch (err) {
      await loaded.dispose();
      throw err;
    }
    if (actual !== digest) {
      await loaded.dispose();
      throw new DigestMismatch(digest, actual, loaded.skill.name);
    }
    return { skill: { ...loaded.skill, digest: actual }, dispose: loaded.dispose };
  }
  throw new SkillNotFound(digest);
}

/** The catalog over all sources, as plain JSON-serializable rows (`source` is the source id). */
export async function listSkills(
  sources: SkillSource[],
): Promise<
  { name: string; description: string; digest: string; version?: string; source: string }[]
> {
  const out = [];
  for (const source of sources) {
    for (const l of await source.list()) {
      out.push({
        name: l.name,
        description: l.description,
        digest: l.digest,
        ...(l.version !== undefined ? { version: l.version } : {}),
        source: source.id,
      });
    }
  }
  return out;
}

/** The current digest of `name` (see `resolveSkill` for ambiguity rules). */
export async function resolve(name: string, sources: SkillSource[]): Promise<string> {
  return (await resolveSkill(name, sources)).digest;
}

/**
 * Loads `{name, digest}`. Throws `DigestMismatch` when the digest is no longer what the named
 * skill holds (edited on disk, moved HEAD), `SkillNotFound` when neither exists.
 */
export async function load(
  ref: { name: string; digest: string },
  sources: SkillSource[],
): Promise<LoadedSkill> {
  let loaded: LoadedSkill;
  try {
    loaded = await loadSkillByDigest(ref.digest, sources);
  } catch (err) {
    if (!(err instanceof SkillNotFound)) throw err;
    // The digest is gone; if the name still exists, report what it holds now.
    const current = await resolveSkill(ref.name, sources);
    throw new DigestMismatch(ref.digest, current.digest, ref.name);
  }
  if (loaded.skill.name !== ref.name) {
    await loaded.dispose();
    throw new SkillNotFound(`${ref.name}@${ref.digest}`);
  }
  return loaded;
}
