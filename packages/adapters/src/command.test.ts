import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAssertion, type Skill, type Workspace } from "@grimoire/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandAdapterConfig,
  createCommandAdapter,
  loadCommandConfig,
  parseCommandConfig,
} from "./command.js";
import { getAdapter } from "./index.js";

// A stand-in agent: a node script run through the node binary (no shell, no .cmd shims), so the
// tests behave the same on Windows and POSIX. It reports what it observed as its stdout.
// The hang/flood/signal modes use real-clock timers on purpose: they exercise execa's actual
// timeout/kill against a live child, which fake timers cannot do. The child exits on its own so a
// failed kill cannot leak a process.
const STUB = `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = process.env.STUB_MODE ?? "echo";
if (args[0] === "--version") { console.log("stub 1.2.3"); process.exit(0); }
if (args[0] === "--broken") { process.exit(4); }
if (mode === "exit3") { console.error("stub failure"); console.log("partial"); process.exit(3); }
if (mode === "hang") { console.log("started"); setTimeout(() => process.exit(0), 8000); }
else if (mode === "flood") { process.stdout.write("x".repeat(5000)); setTimeout(() => process.exit(0), 8000); }
else if (mode === "signal") { process.kill(process.pid, "SIGKILL"); setTimeout(() => process.exit(9), 8000); }
else {
  const stdin = args.includes("--stdin") ? readFileSync(0, "utf8") : null;
  writeFileSync("agent-ran.txt", "yes");
  process.stdout.write(JSON.stringify({
    args, stdin, cwd: process.cwd(), keep: process.env.STUB_KEEP, over: process.env.STUB_OVER,
  }) + "\\n");
}
`;

let tmp: string;
let stub: string;
let ws: Workspace;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "command-adapter-")));
  stub = join(tmp, "stub.mjs");
  await writeFile(stub, STUB);
  ws = { root: join(tmp, "ws"), dir: join(tmp, "ws", "work") };
  await mkdir(ws.dir, { recursive: true });
});
afterEach(async () => {
  delete process.env.STUB_KEEP;
  delete process.env.STUB_OVER;
  await rm(tmp, { recursive: true, force: true });
});

const cfg = (over: Partial<CommandAdapterConfig> = {}): CommandAdapterConfig => ({
  command: process.execPath,
  args: [stub, "{prompt}"],
  ...over,
});
const req = (prompt = "do it", extra: { model?: string; tools?: string[] } = {}) => ({
  prompt,
  timeoutMs: 20_000,
  ...extra,
});
const observed = (finalMessage: string) =>
  JSON.parse(finalMessage) as {
    args: string[];
    stdin: string | null;
    cwd: string;
    keep?: string;
    over?: string;
  };

describe("config validation", () => {
  it("applies defaults", () => {
    expect(parseCommandConfig({ command: "x", args: ["{prompt}"] })).toEqual({
      command: "x",
      args: ["{prompt}"],
      promptVia: "arg",
      env: {},
      maxOutputChars: 10_000_000,
    });
  });

  it.each([
    [{}, "command"],
    [{ command: "x", args: ["a"] }, "needs {prompt}"],
    [{ command: "x", args: [] }, "needs {prompt}"],
    [{ command: "x", promptVia: "stdin", args: ["{prompt}"] }, "cannot be used with"],
    [{ command: "x", args: ["{prompt}"], bogus: 1 }, "bogus"],
    [{ command: "x", args: ["{prompt}"], skillDir: "/abs/skills" }, "inside the workspace"],
    [{ command: "x", args: ["{prompt}"], skillDir: "../up" }, "inside the workspace"],
    [{ command: "x", args: ["{prompt}"], maxOutputChars: 0 }, "maxOutputChars"],
  ])("rejects %j", (config, message) => {
    expect(() => parseCommandConfig(config)).toThrow(message);
  });

  it("names the origin and every field in the error", () => {
    expect(() => parseCommandConfig({ args: "no" }, "agent config x.json")).toThrow(
      /Invalid agent config x\.json: .*command.*args/,
    );
    expect(() => parseCommandConfig("str")).toThrow(/\(root\)/);
  });

  it("accepts nested workspace-relative skill dirs and stdin without a placeholder", () => {
    expect(
      parseCommandConfig({ command: "x", promptVia: "stdin", skillDir: ".codex/skills" }).skillDir,
    ).toBe(".codex/skills");
  });
});

describe("loadCommandConfig", () => {
  it("reads JSON and YAML", async () => {
    await writeFile(join(tmp, "a.json"), JSON.stringify({ command: "x", args: ["{prompt}"] }));
    await writeFile(
      join(tmp, "a.yaml"),
      "id: codex\ncommand: x\nargs: ['exec', '{prompt}']\nenv:\n  A: b\n",
    );
    await writeFile(join(tmp, "b.yml"), "command: y\npromptVia: stdin\n");
    expect((await loadCommandConfig(join(tmp, "a.json"))).command).toBe("x");
    const yaml = await loadCommandConfig(join(tmp, "a.yaml"));
    expect(yaml).toMatchObject({ id: "codex", args: ["exec", "{prompt}"], env: { A: "b" } });
    expect((await loadCommandConfig(join(tmp, "b.yml"))).promptVia).toBe("stdin");
  });

  it("fails clearly on a missing file, bad syntax and invalid content", async () => {
    await expect(loadCommandConfig(join(tmp, "nope.json"))).rejects.toThrow(
      /Cannot read agent config .*nope\.json/,
    );
    await writeFile(join(tmp, "bad.json"), "{ not json");
    await expect(loadCommandConfig(join(tmp, "bad.json"))).rejects.toThrow(
      /Cannot parse agent config .*bad\.json/,
    );
    await writeFile(join(tmp, "bad.yaml"), "a: [unclosed");
    await expect(loadCommandConfig(join(tmp, "bad.yaml"))).rejects.toThrow(/Cannot parse/);
    await writeFile(join(tmp, "inv.yaml"), "args: [x]\n");
    await expect(loadCommandConfig(join(tmp, "inv.yaml"))).rejects.toThrow(
      /Invalid agent config .*inv\.yaml: command/,
    );
  });
});

describe("detect", () => {
  it("is available without a probe", async () => {
    expect(await createCommandAdapter(cfg()).detect()).toEqual({ available: true });
  });

  it("runs the probe (string and argv forms) and reports its first output line", async () => {
    const asArgv = createCommandAdapter(cfg({ detect: [process.execPath, stub, "--version"] }));
    expect(await asArgv.detect()).toEqual({ available: true, version: "stub 1.2.3" });
    // The string form splits on whitespace; use the argv form for paths with spaces.
    const simple = createCommandAdapter(cfg({ detect: "node --version" }));
    expect((await simple.detect()).version).toMatch(/^v\d+/);
  });

  it("is unavailable when the probe fails or the command is missing", async () => {
    const failing = createCommandAdapter(cfg({ detect: [process.execPath, stub, "--broken"] }));
    expect(await failing.detect()).toEqual({ available: false });
    const missing = createCommandAdapter(cfg({ detect: "grimoire-no-such-binary --version" }));
    expect(await missing.detect()).toEqual({ available: false });
  });
});

describe("install", () => {
  const skill = (dir: string): Skill => ({ dir, name: "demo", description: "d", digest: "sha" });

  it("copies the skill into skillDir without the suite and fixtures", async () => {
    const dir = join(tmp, "demo");
    await mkdir(join(dir, "fixtures"), { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# demo");
    await writeFile(join(dir, "grimoire.bench.yaml"), "name: x");
    await writeFile(join(dir, "fixtures", "f.txt"), "f");
    await createCommandAdapter(cfg({ skillDir: ".codex/skills" })).install(skill(dir), ws);
    const dest = join(ws.dir, ".codex", "skills", "demo");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("# demo");
    await expect(readFile(join(dest, "grimoire.bench.yaml"))).rejects.toThrow();
    await expect(readFile(join(dest, "fixtures", "f.txt"))).rejects.toThrow();
  });

  it("is a no-op without skillDir", async () => {
    const dir = join(tmp, "demo");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "# demo");
    await createCommandAdapter(cfg()).install(skill(dir), ws);
    await expect(readFile(join(ws.dir, ".codex"))).rejects.toThrow();
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("# demo");
  });
});

describe("run", () => {
  it("passes the prompt as a single argv element, never through a shell", async () => {
    const prompt = `it's "quoted" $HOME \`id\` & echo pwned; $(whoami)\nsecond line {prompt}`;
    const r = await createCommandAdapter(cfg()).run(req(prompt), ws);
    expect(r.status).toBe("completed");
    expect(observed(r.finalMessage).args).toEqual([prompt]);
    expect(observed(r.finalMessage).stdin).toBeNull();
    expect(r.usage).toBeUndefined();
    expect(r.errorKind).toBeUndefined();
  });

  it("replaces the placeholder inside larger arguments and everywhere it occurs", async () => {
    const adapter = createCommandAdapter(
      cfg({ args: [stub, "--prompt={prompt}", "{prompt}-{prompt}"] }),
    );
    const r = await adapter.run(req("P$1"), ws);
    expect(observed(r.finalMessage).args).toEqual(["--prompt=P$1", "P$1-P$1"]);
  });

  it("runs in the workspace dir and reports one assistant message", async () => {
    const r = await createCommandAdapter(cfg()).run(req(), ws);
    expect(observed(r.finalMessage).cwd).toBe(ws.dir);
    expect(await readFile(join(ws.dir, "agent-ran.txt"), "utf8")).toBe("yes");
    expect(r.transcript).toEqual([{ type: "message", role: "assistant", text: r.rawOutput }]);
    expect(r.finalMessage).toBe(r.rawOutput);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("delivers the prompt on stdin with promptVia stdin", async () => {
    const adapter = createCommandAdapter(cfg({ promptVia: "stdin", args: [stub, "--stdin"] }));
    const r = await adapter.run(req("line1\nline2 {prompt}"), ws);
    expect(r.status).toBe("completed");
    expect(observed(r.finalMessage).stdin).toBe("line1\nline2 {prompt}");
    expect(observed(r.finalMessage).args).toEqual(["--stdin"]);
  });

  it("inherits the process env and lets config env add and override", async () => {
    process.env.STUB_KEEP = "from-process";
    process.env.STUB_OVER = "from-process";
    const r = await createCommandAdapter(cfg({ env: { STUB_OVER: "from-config" } })).run(req(), ws);
    expect(observed(r.finalMessage)).toMatchObject({ keep: "from-process", over: "from-config" });
  });

  it("appends modelArg and the model only when the config declares modelArg", async () => {
    const withArg = createCommandAdapter(cfg({ modelArg: "--model" }));
    expect(observed((await withArg.run(req("p", { model: "m1" }), ws)).finalMessage).args).toEqual([
      "p",
      "--model",
      "m1",
    ]);
    expect(observed((await withArg.run(req("p"), ws)).finalMessage).args).toEqual(["p"]);
    const without = createCommandAdapter(cfg());
    expect(
      observed((await without.run(req("p", { model: "m1", tools: ["Bash"] }), ws)).finalMessage)
        .args,
    ).toEqual(["p"]);
  });

  it("maps a non-zero exit to an agent error carrying stderr", async () => {
    const r = await createCommandAdapter(cfg({ env: { STUB_MODE: "exit3" } })).run(req(), ws);
    expect(r).toMatchObject({ status: "error", errorKind: "agent", finalMessage: "partial" });
    expect(r.error).toMatch(/exited 3: stub failure/);
  });

  it("maps a timeout to status timeout and keeps partial output", async () => {
    const r = await createCommandAdapter(cfg({ env: { STUB_MODE: "hang" } })).run(
      { prompt: "p", timeoutMs: 1500 },
      ws,
    );
    expect(r.status).toBe("timeout");
    expect(r.error).toMatch(/timed out after 1500ms/);
    expect(r.errorKind).toBeUndefined();
  });

  it("stops an agent that exceeds the output cap and reports an agent error", async () => {
    const r = await createCommandAdapter(
      cfg({ env: { STUB_MODE: "flood" }, maxOutputChars: 100 }),
    ).run(req(), ws);
    expect(r).toMatchObject({ status: "error", errorKind: "agent" });
    expect(r.error).toMatch(/exceeded 100 characters/);
    expect(r.rawOutput.length).toBe(100);
    // The stub would run for 8s: the adapter must stop it, not wait for it.
    expect(r.durationMs).toBeLessThan(6000);
  });

  it("maps a kill by signal to an agent error", async () => {
    const r = await createCommandAdapter(cfg({ env: { STUB_MODE: "signal" } })).run(req(), ws);
    expect(r).toMatchObject({ status: "error", errorKind: "agent" });
  });

  it("maps a missing executable to an infrastructure error", async () => {
    const r = await createCommandAdapter(cfg({ command: "grimoire-no-such-binary" })).run(
      req(),
      ws,
    );
    expect(r).toMatchObject({ status: "error", errorKind: "infrastructure", transcript: [] });
    expect(r.error).toMatch(/"grimoire-no-such-binary" was not found/);
  });

  it("resolves a path-style command against the workspace", async () => {
    const r = await createCommandAdapter(cfg({ command: "./missing-here.sh" })).run(req(), ws);
    expect(r.errorKind).toBe("infrastructure");
  });
});

describe("skill_loaded on a command-adapter result", () => {
  it("fails with a clear message because the transcript has no skill events", async () => {
    const result = await createCommandAdapter(cfg()).run(req(), ws);
    const skill: Skill = { dir: tmp, name: "demo", description: "d", digest: "sha" };
    const r = await evaluateAssertion({ type: "skill_loaded" }, { ws, result, skill });
    expect(r).toMatchObject({ type: "skill_loaded", passed: false });
    expect(r.detail).toContain('skill "demo" was never invoked');
    // The baseline arm has no skill, so the assertion is skipped there as for every agent.
    expect((await evaluateAssertion({ type: "skill_loaded" }, { ws, result })).passed).toBe(true);
  });
});

describe("getAdapter", () => {
  it("builds the command adapter from a config and uses its id", () => {
    expect(getAdapter("command", { config: { command: "x", args: ["{prompt}"] } }).id).toBe(
      "command",
    );
    expect(
      getAdapter("command", { config: { id: "codex", command: "x", promptVia: "stdin" } }).id,
    ).toBe("codex");
  });

  it("explains that the command agent needs a config, and validates it", () => {
    expect(() => getAdapter("command")).toThrow(/needs a config/);
    expect(() => getAdapter("command", { config: { args: [] } })).toThrow(/Invalid agent config/);
  });

  it("keeps the existing agents and the unknown-agent error", () => {
    expect(getAdapter("claude-code").id).toBe("claude-code");
    expect(() => getAdapter("nope")).toThrow(
      /Unknown agent "nope". Available: claude-code, command/,
    );
  });
});
