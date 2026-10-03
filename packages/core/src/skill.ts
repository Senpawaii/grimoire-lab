import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { digestDir } from "./digest.js";
import type { Skill } from "./types.js";

const SemVer = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const Frontmatter = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name must be kebab-case (a-z, 0-9, hyphens)"),
    description: z.string().min(1, "description is required"),
    // YAML parses `1.2` as a number, so check type and format together.
    version: z
      .custom<string>(
        (v) => typeof v === "string" && SemVer.test(v),
        "version must be a semver string (e.g. 1.2.0)",
      )
      .optional(),
  })
  .loose();

/** Splits `---\nyaml\n---\nbody`. Throws if there is no frontmatter block. */
export function splitFrontmatter(source: string): { data: unknown; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(source);
  if (!m) throw new Error("SKILL.md must start with a YAML frontmatter block delimited by ---");
  return { data: parse(m[1] ?? ""), body: m[2] ?? "" };
}

export async function loadSkill(dir: string): Promise<Skill> {
  const abs = resolve(dir);
  let source: string;
  try {
    source = await readFile(join(abs, "SKILL.md"), "utf8");
  } catch {
    throw new Error(`No SKILL.md found in ${abs}`);
  }
  const { data } = splitFrontmatter(source);
  const parsed = Frontmatter.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`,
    );
    throw new Error(`Invalid SKILL.md in ${abs}:\n  ${issues.join("\n  ")}`);
  }
  const { name, description, version } = parsed.data;
  return { dir: abs, name, description, version, digest: await digestDir(abs) };
}
