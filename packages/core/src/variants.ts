import type { Skill } from "./types.js";

/** One arm of a comparison. No skill means the baseline. */
export interface Variant {
  label: string;
  skill?: Skill;
}

const shortDigest = (s: Skill) => s.digest.replace("sha256:", "").slice(0, 8);

/**
 * Default comparison is baseline vs the skill. With `against`, it is `against` vs `current`
 * (older first). Labels are `name@version`, or `name@digest8` without a version; when both
 * sides share a label (edited but not re-versioned) both get a `+digest8` suffix.
 */
export function buildVariants(current: Skill, against?: Skill): Variant[] {
  if (!against) return [{ label: "baseline" }, { label: "with-skill", skill: current }];
  if (against.digest === current.digest) {
    throw new Error(
      `Both sides have identical contents (${current.digest.slice(0, 19)}); there is nothing to compare`,
    );
  }
  const base = (s: Skill) => `${s.name}@${s.version ?? shortDigest(s)}`;
  const clash = base(against) === base(current);
  const label = (s: Skill) => (clash ? `${base(s)}+${shortDigest(s)}` : base(s));
  return [
    { label: label(against), skill: against },
    { label: label(current), skill: current },
  ];
}
