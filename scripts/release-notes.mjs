// Release helper used by .github/workflows/release.yml.
//   node scripts/release-notes.mjs <tag>
// Checks that <tag> is `v<semver>` and equals packages/core/package.json's version, then prints the
// matching `## <version>` section of CHANGELOG.md to stdout. Exits 1 with a message otherwise.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] ?? "";

function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!m) fail(`tag "${tag}" must look like v1.2.3 (or v1.2.3-rc.1)`);
const version = m[1];

const pkg = JSON.parse(readFileSync(join(root, "packages", "core", "package.json"), "utf8"));
if (pkg.version !== version) {
  fail(`tag ${tag} does not match packages/core/package.json version ${pkg.version}`);
}

const lines = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const heading = new RegExp(`^## \\[?${version.replace(/[.+]/g, "\\$&")}\\]?(\\s|$)`);
const start = lines.findIndex((l) => heading.test(l));
if (start === -1)
  fail(`CHANGELOG.md has no "## ${version}" section (rename "Unreleased" before tagging)`);
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end === -1) end = lines.length;
const body = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (!body) fail(`the "## ${version}" section of CHANGELOG.md is empty`);
process.stdout.write(`${body}\n`);
