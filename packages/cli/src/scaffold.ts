import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const skillMd = (name: string) => `---
name: ${name}
description: Use when <describe the situation that should trigger this skill>.
version: 0.1.0
---

# ${name}

Instructions for the agent go here.
`;

const benchYaml = (name: string) => `suite: ${name}-basic
defaults:
  repeat: 3
  timeoutMs: 180000
tasks:
  - id: example
    prompt: "Describe the task the skill should help with."
    # fixtures: ./fixtures/example   # copied into the workspace before the run
    assertions:
      - { type: skill_loaded }       # only evaluated in the with-skill cell
      - { type: file_exists, path: output.txt }
`;

/** Creates `<baseDir>/<name>/{SKILL.md,grimoire.bench.yaml}` and returns the skill directory. */
export async function scaffoldSkill(name: string, baseDir: string): Promise<string> {
  if (!NAME.test(name)) {
    throw new Error(`Invalid skill name "${name}": use kebab-case (a-z, 0-9, hyphens)`);
  }
  const dir = resolve(baseDir, name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd(name));
  await writeFile(join(dir, "grimoire.bench.yaml"), benchYaml(name));
  return dir;
}
