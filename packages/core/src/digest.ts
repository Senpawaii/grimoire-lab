import { createHash, type Hash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/** Benchmark inputs are not part of the skill; editing a suite must not change the digest. */
const EXCLUDED_AT_ROOT: Record<string, true> = {
  "grimoire.bench.yaml": true,
  fixtures: true,
  ".git": true,
};

/** File-manager litter at any depth; browsing a folder must not make a new version (lowercase). */
const OS_JUNK_FILES: Record<string, true> = {
  ".ds_store": true,
  "thumbs.db": true,
  "desktop.ini": true,
};

/** Files that make up a skill (posix paths relative to `root`), excluding benchmark inputs. */
export async function listSkillFiles(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (rel === "" && EXCLUDED_AT_ROOT[e.name]) continue;
    if (OS_JUNK_FILES[e.name.toLowerCase()]) continue;
    const childRel = rel === "" ? e.name : posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await listSkillFiles(root, childRel)));
    else if (e.isFile()) out.push(childRel);
  }
  return out;
}

/**
 * Feeds (posix path, content) pairs into `hash`. Text files are LF-normalized so a Windows
 * checkout with CRLF hashes the same as a Linux one.
 */
export async function updateHashWithFiles(
  hash: Hash,
  root: string,
  files: readonly string[],
): Promise<void> {
  for (const rel of files) {
    let data = await readFile(join(root, rel));
    const isBinary = data.subarray(0, 8000).includes(0);
    if (!isBinary) data = Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"));
    hash.update(`${rel}\0${data.length}\0`);
    hash.update(data);
  }
}

/** sha256 over sorted (posix path, content) pairs; see `updateHashWithFiles`. */
export async function digestDir(dir: string): Promise<string> {
  const files = (await listSkillFiles(dir)).sort();
  const hash = createHash("sha256");
  await updateHashWithFiles(hash, dir, files);
  return `sha256:${hash.digest("hex")}`;
}
