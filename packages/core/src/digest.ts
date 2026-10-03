import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/** Benchmark inputs are not part of the skill; editing a suite must not change the digest. */
const EXCLUDED_AT_ROOT: Record<string, true> = {
  "grimoire.bench.yaml": true,
  fixtures: true,
  ".git": true,
};

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (rel === "" && EXCLUDED_AT_ROOT[e.name]) continue;
    const childRel = rel === "" ? e.name : posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(root, childRel)));
    else if (e.isFile()) out.push(childRel);
  }
  return out;
}

/**
 * sha256 over sorted (posix path, content) pairs. Text files are LF-normalized so a
 * Windows checkout with CRLF hashes the same as a Linux one.
 */
export async function digestDir(dir: string): Promise<string> {
  const files = (await listFiles(dir)).sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    let data = await readFile(join(dir, rel));
    const isBinary = data.subarray(0, 8000).includes(0);
    if (!isBinary) data = Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"));
    hash.update(`${rel}\0${data.length}\0`);
    hash.update(data);
  }
  return `sha256:${hash.digest("hex")}`;
}
