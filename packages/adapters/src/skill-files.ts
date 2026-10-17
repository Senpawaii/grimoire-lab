import { cp } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { Skill } from "@grimoire/core";

const NOT_PART_OF_SKILL: Record<string, true> = { "grimoire.bench.yaml": true, fixtures: true };

/** Copies a skill folder to `dest`, leaving out the benchmark suite and its fixtures. */
export async function copySkill(skill: Skill, dest: string): Promise<void> {
  await cp(skill.dir, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(skill.dir, src);
      return !NOT_PART_OF_SKILL[rel.split(sep)[0] ?? ""];
    },
  });
}
