import type { AgentAdapter } from "@grimoire/core";
import { claudeCode } from "./claude-code.js";

export { claudeCode, parseStreamJson } from "./claude-code.js";

const ADAPTERS: Record<string, AgentAdapter> = { [claudeCode.id]: claudeCode };

export function getAdapter(id: string): AgentAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(`Unknown agent "${id}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}
