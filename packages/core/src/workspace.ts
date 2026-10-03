import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Workspace } from "./types.js";

/** Fresh scratch directory per trial, seeded from the task fixtures. */
export async function createWorkspace(fixturesDir?: string): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "grimoire-"));
  const dir = join(root, "work");
  await mkdir(dir);
  if (fixturesDir) await cp(fixturesDir, dir, { recursive: true });
  return { root, dir };
}

export async function destroyWorkspace(ws: Workspace): Promise<void> {
  await rm(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Resolves `p` against `dir`, throwing if the result would leave `dir`. */
export function resolveInside(dir: string, p: string): string {
  const abs = resolve(dir, p);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path "${p}" escapes the workspace`);
  }
  return abs;
}
