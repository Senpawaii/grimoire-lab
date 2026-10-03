import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSuite } from "./suite.js";

const base = resolve("/suites");

const minimal = `
suite: demo
tasks:
  - id: t1
    prompt: do it
    assertions:
      - { type: file_exists, path: out.txt }
`;

describe("parseSuite", () => {
  it("applies defaults and resolves fixtures relative to the suite file", () => {
    const suite = parseSuite(
      `
suite: demo
defaults: { repeat: 5 }
tasks:
  - id: t1
    prompt: p
    fixtures: ./fx
    assertions: [{ type: skill_loaded }]
  - id: t2
    prompt: p
    timeoutMs: 1000
    assertions: [{ type: command, run: "true" }]
`,
      base,
    );
    expect(suite.repeat).toBe(5);
    expect(suite.tasks[0]).toMatchObject({ fixturesDir: resolve(base, "fx"), timeoutMs: 180_000 });
    expect(suite.tasks[1]).toMatchObject({ timeoutMs: 1000 });
    expect(suite.tasks[1]?.assertions[0]).toMatchObject({ type: "command", exitCode: 0 });
  });

  it("defaults repeat to 3", () => {
    expect(parseSuite(minimal, base).repeat).toBe(3);
  });

  it.each([
    ["unknown assertion type", minimal.replace("file_exists", "file_exits"), /type/],
    ["unknown top-level key", `${minimal}judge: {}`, /judge/],
    [
      "task without assertions",
      "suite: s\ntasks: [{ id: a, prompt: p, assertions: [] }]",
      /at least one assertion/,
    ],
    [
      "invalid regex",
      minimal.replace("file_exists, path: out.txt", "file_contains, path: a, regex: '('"),
      /regular expression/,
    ],
    ["bad task id", minimal.replace("id: t1", "id: 'a b'"), /task id/],
    [
      "max with non-positive value",
      minimal.replace(
        "{ type: file_exists, path: out.txt }",
        "{ type: max, metric: tokens, value: 0 }",
      ),
      /value/,
    ],
  ])("rejects %s", (_label, source, message) => {
    expect(() => parseSuite(source, base)).toThrow(message);
  });

  it("rejects duplicate task ids", () => {
    const dup = `${minimal}  - id: t1\n    prompt: p\n    assertions: [{ type: skill_loaded }]\n`;
    expect(() => parseSuite(dup, base)).toThrow(/duplicate task id "t1"/);
  });
});
