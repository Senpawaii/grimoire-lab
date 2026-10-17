import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { updateHashWithFiles } from "./digest.js";
import type { Suite } from "./suite.js";

async function listAllFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const childRel = rel === "" ? e.name : posix.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await listAllFiles(root, childRel)));
    else if (e.isFile()) out.push(childRel);
  }
  return out;
}

/** JSON with sorted object keys and no `undefined` members, so equal values hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * sha256 identity of what the agent is asked to do and how it is graded: every task's id,
 * prompt, timeout, assertions, judge spec and fixture contents (LF-normalized, like
 * `digestDir`). Tasks are sorted by id, so reordering a suite does not change the digest.
 * The suite name and the repeat count are labels, not identity: results with different repeat
 * counts stay comparable.
 */
export async function digestSuite(suite: Suite): Promise<string> {
  const hash = createHash("sha256");
  const tasks = [...suite.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const t of tasks) {
    hash.update(
      `${canonical({
        id: t.id,
        prompt: t.prompt,
        timeoutMs: t.timeoutMs,
        assertions: t.assertions,
        judge: t.judge,
        fixtures: t.fixturesDir !== undefined,
      })}\0`,
    );
    if (t.fixturesDir !== undefined) {
      await updateHashWithFiles(hash, t.fixturesDir, (await listAllFiles(t.fixturesDir)).sort());
    }
    hash.update("\0task-end\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
