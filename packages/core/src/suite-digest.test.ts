import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSuite } from "./suite.js";
import { digestSuite } from "./suite-digest.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "suite-digest-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const tasks = {
  t1: "  - id: t1\n    prompt: one\n    fixtures: ./fx\n    assertions: [{ type: file_exists, path: out.txt }]",
  t2: "  - id: t2\n    prompt: two\n    assertions: [{ type: file_exists, path: b.txt }]",
};
const suite = (body: string, head = "suite: s\ndefaults: { repeat: 2 }") =>
  parseSuite(`${head}\ntasks:\n${body}`, tmp);

describe("digestSuite", () => {
  beforeEach(async () => {
    await mkdir(join(tmp, "fx"));
    await writeFile(join(tmp, "fx", "in.txt"), "data\n");
  });

  it("is a sha256 that is stable across calls and task order", async () => {
    const a = await digestSuite(suite(`${tasks.t1}\n${tasks.t2}`));
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await digestSuite(suite(`${tasks.t1}\n${tasks.t2}`))).toBe(a);
    expect(await digestSuite(suite(`${tasks.t2}\n${tasks.t1}`))).toBe(a);
  });

  it("ignores the suite name and repeat count (labels, not identity)", async () => {
    const a = await digestSuite(suite(tasks.t2));
    const b = await digestSuite(suite(tasks.t2, "suite: renamed\ndefaults: { repeat: 9 }"));
    expect(b).toBe(a);
  });

  it("changes with a prompt, an assertion, a timeout or the task set", async () => {
    const base = await digestSuite(suite(tasks.t2));
    const variants = [
      tasks.t2.replace("two", "changed"),
      tasks.t2.replace("b.txt", "c.txt"),
      `${tasks.t2}\n    timeoutMs: 5`,
    ];
    for (const v of variants) expect(await digestSuite(suite(v))).not.toBe(base);
    expect(await digestSuite(suite(`${tasks.t2}\n${tasks.t1}`))).not.toBe(base);
  });

  it("changes with fixture contents, not with CRLF line endings", async () => {
    const s = suite(tasks.t1);
    const base = await digestSuite(s);
    await writeFile(join(tmp, "fx", "in.txt"), "data\r\n");
    expect(await digestSuite(s)).toBe(base);
    await writeFile(join(tmp, "fx", "in.txt"), "other\n");
    expect(await digestSuite(s)).not.toBe(base);
    await writeFile(join(tmp, "fx", "in.txt"), "data\n");
    await writeFile(join(tmp, "fx", "extra.txt"), "x");
    expect(await digestSuite(s)).not.toBe(base);
  });
});
