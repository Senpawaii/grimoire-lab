import type { AgentAdapter } from "@grimoire/core";
import { claudeCode } from "./claude-code.js";
import { createCommandAdapter, parseCommandConfig } from "./command.js";
import { omp } from "./omp.js";

export { claudeCode, parseStreamJson } from "./claude-code.js";
export {
  type CommandAdapterConfig,
  CommandAdapterConfigSchema,
  createCommandAdapter,
  loadCommandConfig,
  PROMPT_PLACEHOLDER,
  parseCommandConfig,
} from "./command.js";
export { omp, parseOmpJson } from "./omp.js";

export interface GetAdapterOptions {
  /** Adapter configuration; required by (and only used for) the `command` adapter. */
  config?: unknown;
}

const ADAPTERS: Record<string, (opts: GetAdapterOptions) => AgentAdapter> = {
  [claudeCode.id]: () => claudeCode,
  [omp.id]: () => omp,
  command: (opts) => {
    if (opts.config === undefined) {
      throw new Error(
        'The "command" agent needs a config (programmatic: getAdapter("command", { config }); CLI: --agent-config <file>)',
      );
    }
    return createCommandAdapter(parseCommandConfig(opts.config));
  },
};

export function getAdapter(id: string, opts: GetAdapterOptions = {}): AgentAdapter {
  const factory = ADAPTERS[id];
  if (!factory) {
    throw new Error(`Unknown agent "${id}". Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return factory(opts);
}
