#!/usr/bin/env node
import { CommanderError } from "commander";
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) process.exit(err.exitCode);
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
