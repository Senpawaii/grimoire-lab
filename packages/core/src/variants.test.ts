import { describe, expect, it } from "vitest";
import type { Skill } from "./types.js";
import { buildVariants } from "./variants.js";

const skill = (over: Partial<Skill> = {}): Skill => ({
  dir: "/s",
  name: "demo",
  description: "d",
  version: "1.0.0",
  digest: "sha256:aaaaaaaabbbbbbbb",
  ...over,
});

describe("buildVariants", () => {
  it("compares baseline with the skill by default", () => {
    const s = skill();
    expect(buildVariants(s)).toEqual([{ label: "baseline" }, { label: "with-skill", skill: s }]);
  });

  it("puts the other version first and labels both by name@version", () => {
    const old = skill({ version: "0.9.0", digest: "sha256:11111111" });
    const current = skill();
    expect(buildVariants(current, old)).toEqual([
      { label: "demo@0.9.0", skill: old },
      { label: "demo@1.0.0", skill: current },
    ]);
  });

  it("falls back to a digest prefix for unversioned skills", () => {
    const old = skill({ version: undefined, digest: "sha256:deadbeef0000" });
    const current = skill({ version: undefined });
    expect(buildVariants(current, old).map((v) => v.label)).toEqual([
      "demo@deadbeef",
      "demo@aaaaaaaa",
    ]);
  });

  it("disambiguates both labels when an edited skill kept its version", () => {
    const old = skill({ digest: "sha256:11111111" });
    const current = skill({ digest: "sha256:22222222" });
    expect(buildVariants(current, old).map((v) => v.label)).toEqual([
      "demo@1.0.0+11111111",
      "demo@1.0.0+22222222",
    ]);
  });

  it("refuses to compare identical contents", () => {
    expect(() => buildVariants(skill(), skill({ dir: "/other" }))).toThrow(/identical contents/);
  });
});
