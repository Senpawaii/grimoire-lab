import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "@grimoire/adapters";
import {
  type BenchResult,
  benchSkill,
  loadSkill,
  loadSuite,
  ResultStore,
  TaskResultSchema,
} from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "./program.js";
import { scaffoldSkill } from "./scaffold.js";

// A stub agent run through the real command adapter: it records that it ran and whether the skill
// was installed where the config says (.codex/skills/<name>), so skill vs baseline is observable.
const STUB = `
import { existsSync, writeFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("stub-agent 0.0.1"); process.exit(0); }
writeFileSync("agent-ran.txt", process.argv[2] ?? "");
if (existsSync(".codex/skills/demo/SKILL.md")) writeFileSync("skill-seen.txt", "yes");
console.log("done: " + process.argv[2]);
`;

const SUITE = `suite: demo-command
defaults:
  repeat: 2
  timeoutMs: 20000
tasks:
  - id: ran
    prompt: "say hi"
    assertions:
      - { type: file_exists, path: agent-ran.txt }
      - { type: file_contains, path: agent-ran.txt, regex: "^say hi$" }
  - id: skill-installed
    prompt: "say hi"
    assertions:
      - { type: file_exists, path: skill-seen.txt }
  - id: skill-loaded
    prompt: "say hi"
    assertions:
      - { type: skill_loaded }
`;

let tmp: string;
let skillDir: string;
let configJson: string;
let configYaml: string;
let out: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cli-command-agent-"));
  const stub = join(tmp, "stub.mjs");
  await writeFile(stub, STUB);
  skillDir = await scaffoldSkill("demo", tmp);
  await writeFile(join(skillDir, "grimoire.bench.yaml"), SUITE);
  out = join(tmp, "out");

  const config = {
    id: "stub-agent",
    command: process.execPath,
    args: [stub, "{prompt}"],
    skillDir: ".codex/skills",
    detect: [process.execPath, stub, "--version"],
  };
  configJson = join(tmp, "agent.json");
  await writeFile(configJson, JSON.stringify(config));
  // JSON strings are valid YAML scalars, which keeps Windows paths intact.
  configYaml = join(tmp, "agent.yaml");
  await writeFile(
    configYaml,
    [
      "id: stub-agent",
      `command: ${JSON.stringify(process.execPath)}`,
      `args: [${JSON.stringify(stub)}, "{prompt}"]`,
      "skillDir: .codex/skills",
      `detect: [${JSON.stringify(process.execPath)}, ${JSON.stringify(stub)}, "--version"]`,
    ].join("\n"),
  );
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function run(args: string[]) {
  const lines: string[] = [];
  await createProgram((l) => lines.push(l)).parseAsync(["node", "grimoire", ...args]);
  return lines.join("\n");
}

function savedResult(id = 1): BenchResult {
  const store = new ResultStore(join(out, "results.db"));
  try {
    const result = store.getResult(id);
    if (!result) throw new Error("no saved result");
    return result;
  } finally {
    store.close();
  }
}

/** passes per task id for the arm with this label. */
const passes = (result: BenchResult, label: string) => {
  const arm = result.arms.find((a) => a.label === label);
  if (!arm) throw new Error(`no arm ${label}`);
  return Object.fromEntries(
    arm.tasks.map((t) => [TaskResultSchema.parse(t).taskId, t.score.passes]),
  );
};

describe("bench --agent command --agent-config", () => {
  for (const [kind, file] of [
    ["JSON", () => configJson],
    ["YAML", () => configYaml],
  ] as const) {
    it(`runs the suite through the command adapter from a ${kind} config and saves the report`, async () => {
      const text = await run([
        "bench",
        skillDir,
        "--agent",
        "command",
        "--agent-config",
        file(),
        "--out",
        out,
      ]);

      expect(text).toContain("demo-command: 3 task(s) x 2 repeat(s) x 2 variants");
      expect(text).toMatch(/baseline/);
      expect(text).toMatch(/with-skill/);
      expect(text).not.toContain("warning:");

      const result = savedResult();
      expect(result.arms[0]?.agent).toMatchObject({
        id: "stub-agent",
        version: "stub-agent 0.0.1",
      });
      // Both arms run the agent; only the with-skill arm has the skill installed.
      expect(passes(result, "baseline")).toEqual({
        ran: 2,
        "skill-installed": 0,
        "skill-loaded": 2,
      });
      // skill_loaded cannot be evaluated for an agent without skill events: it fails when a skill
      // is installed (the baseline arm skips it).
      expect(passes(result, "with-skill")).toEqual({
        ran: 2,
        "skill-installed": 2,
        "skill-loaded": 0,
      });
      const loaded = result.arms
        .find((a) => a.label === "with-skill")
        ?.tasks.find((t) => t.taskId === "skill-loaded")?.trials[0];
      expect(loaded?.assertions[0]?.detail).toContain('skill "demo" was never invoked');
      expect(loaded?.finalMessage).toBe("done: say hi");
      expect(loaded?.tokens).toBeUndefined();
    });
  }

  it("works for propose", async () => {
    const candidate = join(tmp, "candidate");
    await cp(skillDir, candidate, { recursive: true });
    await writeFile(
      join(candidate, "SKILL.md"),
      "---\nname: demo\ndescription: edited\n---\nbody\n",
    );
    const text = await run([
      "propose",
      skillDir,
      "--candidate",
      candidate,
      "--agent",
      "command",
      "--agent-config",
      configJson,
      "--out",
      out,
    ]);
    expect(text).toContain("Verdict:");
    expect(savedResult().arms[0]?.agent.id).toBe("stub-agent");
  });

  it("warns that skill vs baseline is not meaningful when the config has no skillDir", async () => {
    const noSkill = join(tmp, "noskill.json");
    const config = JSON.parse(await readFile(configJson, "utf8"));
    delete config.skillDir;
    await writeFile(noSkill, JSON.stringify(config));
    const text = await run([
      "bench",
      skillDir,
      "--agent",
      "command",
      "--agent-config",
      noSkill,
      "--out",
      out,
    ]);
    expect(text).toMatch(/warning: the agent config has no skillDir/);
    expect(passes(savedResult(), "with-skill")["skill-installed"]).toBe(0);
  });

  it("rejects bad usage with clear messages", async () => {
    const base = ["bench", skillDir, "--out", out];
    await expect(run([...base, "--agent-config", configJson])).rejects.toThrow(
      /--agent-config configures the command adapter: pass --agent command \(got --agent claude-code\)/,
    );
    await expect(run([...base, "--agent", "command"])).rejects.toThrow(
      /"command" agent needs a config.*--agent-config/,
    );
    await expect(
      run([...base, "--agent", "command", "--agent-config", join(tmp, "missing.json")]),
    ).rejects.toThrow(/Cannot read agent config .*missing\.json/);
    const bad = join(tmp, "bad.yaml");
    await writeFile(bad, "command: x\nargs: [no-placeholder]\n");
    await expect(run([...base, "--agent", "command", "--agent-config", bad])).rejects.toThrow(
      /Invalid agent config .*bad\.yaml: args: promptVia "arg" needs \{prompt\}/,
    );
  });
});

describe("resume with --agent-config", () => {
  async function interrupted() {
    await mkdir(out, { recursive: true });
    const store = new ResultStore(join(out, "results.db"));
    const ac = new AbortController();
    let n = 0;
    try {
      await expect(
        benchSkill({
          skill: await loadSkill(skillDir),
          suite: await loadSuite(join(skillDir, "grimoire.bench.yaml")),
          adapter: getAdapter("command", { config: JSON.parse(await readConfig()) }),
          outDir: out,
          store,
          signal: ac.signal,
          onTrial: () => {
            if (++n === 3) ac.abort();
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      store.close();
    }
  }
  const readConfig = () => readFile(configJson, "utf8");

  it("finishes the run with the command adapter built from the config", async () => {
    await interrupted();
    const text = await run([
      "resume",
      "1",
      "--skill",
      skillDir,
      "--agent-config",
      configYaml,
      "--out",
      out,
    ]);
    expect(text).toContain("Resuming run 1 (demo-command) on stub-agent");
    expect(passes(savedResult(), "with-skill")).toEqual({
      ran: 2,
      "skill-installed": 2,
      "skill-loaded": 0,
    });
  });

  it("explains how to resume a command-adapter run, and rejects a conflicting --agent", async () => {
    await interrupted();
    await expect(run(["resume", "1", "--skill", skillDir, "--out", out])).rejects.toThrow(
      /Unknown agent "stub-agent".*used agent "stub-agent".*--agent-config <file>/,
    );
    await expect(
      run([
        "resume",
        "1",
        "--skill",
        skillDir,
        "--agent",
        "claude-code",
        "--agent-config",
        configJson,
        "--out",
        out,
      ]),
    ).rejects.toThrow(/pass --agent command/);
    // A config whose id differs from the run's agent is refused by the engine.
    const other = join(tmp, "other.json");
    const config = JSON.parse(await readConfig());
    await writeFile(other, JSON.stringify({ ...config, id: "someone-else" }));
    await expect(
      run(["resume", "1", "--skill", skillDir, "--agent-config", other, "--out", out]),
    ).rejects.toThrow(/used agent "stub-agent"/);
  });
});
