import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestDir } from "./digest.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "digest-test-"));
  await mkdir(join(dir, "scripts"));
  await writeFile(join(dir, "SKILL.md"), "line1\nline2\n");
  await writeFile(join(dir, "scripts", "run.sh"), "echo hi\n");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("digestDir", () => {
  it("is identical for CRLF and LF checkouts", async () => {
    const lf = await digestDir(dir);
    await writeFile(join(dir, "SKILL.md"), "line1\r\nline2\r\n");
    expect(await digestDir(dir)).toBe(lf);
  });

  it("changes when any file's content changes", async () => {
    const before = await digestDir(dir);
    await writeFile(join(dir, "scripts", "run.sh"), "echo bye\n");
    expect(await digestDir(dir)).not.toBe(before);
  });

  it("changes when a file moves, even with identical content", async () => {
    const before = await digestDir(dir);
    await writeFile(join(dir, "scripts", "run2.sh"), "echo hi\n");
    await rm(join(dir, "scripts", "run.sh"));
    expect(await digestDir(dir)).not.toBe(before);
  });

  it("ignores the benchmark suite and fixtures", async () => {
    const before = await digestDir(dir);
    await writeFile(join(dir, "grimoire.bench.yaml"), "suite: x");
    await mkdir(join(dir, "fixtures"));
    await writeFile(join(dir, "fixtures", "a.txt"), "data");
    expect(await digestDir(dir)).toBe(before);
  });
});
