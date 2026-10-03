import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkill } from "./skill.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skill-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const write = (content: string) => writeFile(join(dir, "SKILL.md"), content);

describe("loadSkill", () => {
  it("reads name, description, version and computes a digest", async () => {
    await write("---\nname: pdf-extract\ndescription: Extract PDFs\nversion: 1.2.0\n---\nbody\n");
    const skill = await loadSkill(dir);
    expect(skill).toMatchObject({
      name: "pdf-extract",
      description: "Extract PDFs",
      version: "1.2.0",
    });
    expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps unknown frontmatter keys from failing validation (Claude skills stay valid)", async () => {
    await write("---\nname: a\ndescription: d\nallowed-tools: Read\n---\n");
    await expect(loadSkill(dir)).resolves.toMatchObject({ name: "a" });
  });

  it("accepts CRLF files", async () => {
    await write("---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n");
    await expect(loadSkill(dir)).resolves.toMatchObject({ name: "a" });
  });

  it.each([
    ["missing description", "---\nname: a\n---\n", /description/],
    ["non-kebab name", "---\nname: Bad_Name\ndescription: d\n---\n", /kebab-case/],
    ["non-semver version", "---\nname: a\ndescription: d\nversion: 1.2\n---\n", /semver/],
    ["no frontmatter", "just text", /frontmatter/],
  ])("rejects %s", async (_label, content, message) => {
    await write(content);
    await expect(loadSkill(dir)).rejects.toThrow(message);
  });

  it("reports a missing SKILL.md", async () => {
    await mkdir(join(dir, "empty"));
    await expect(loadSkill(join(dir, "empty"))).rejects.toThrow(/No SKILL.md/);
  });
});
