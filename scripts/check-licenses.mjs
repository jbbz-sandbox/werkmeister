#!/usr/bin/env node
/**
 * SW-63: fail when any npm package in package-lock.json carries a licence outside
 * the allowlist below. Reads the lockfile rather than node_modules, so every
 * platform's optional binaries are covered. See docs/third-party.md § Checking
 * npm licences.
 *
 * npm copies a package's `license` into the lockfile but drops the legacy
 * `licenses` array, so for those few it falls back to the installed package.json:
 * run it after `npm ci`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Permissive licences (SPDX ids) any dependency may carry: OSI-approved, plus CC0-1.0. */
export const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/** Packages whose terms were read by hand. A new one needs a reason here and a row in the doc. */
export const REVIEWED = {
  "@anthropic-ai/claude-agent-sdk":
    "Anthropic Commercial Terms; installed from npm, never bundled (esbuild external)",
  "@vscode/vsce-sign": "Microsoft licence terms; dev-only, used by `vsce package`",
  "@azu/style-format": "WTFPL; dev-only, under @vscode/vsce",
  "spdx-exceptions": "CC-BY-3.0 data file; dev-only, under @changesets/cli",
  spawndamnit: "MIT text behind `SEE LICENSE IN LICENSE`; dev-only, under @changesets/cli",
};

/** True when an SPDX expression is satisfied by the allowlist: any `OR` branch, every `AND` term. */
export function allowed(expr) {
  return expr
    .replace(/[()]/g, "")
    .split(" OR ")
    .some((branch) => branch.split(" AND ").every((id) => ALLOWED.has(id.trim())));
}

/** `@vscode/vsce-sign-darwin-x64` → `@vscode/vsce-sign`: platform binaries share their parent's terms. */
function reviewedName(name) {
  return Object.keys(REVIEWED).find((r) => name === r || name.startsWith(`${r}-`));
}

function licenseOf(root, path, entry) {
  if (entry.license) return entry.license;
  const pj = join(root, path, "package.json");
  if (!existsSync(pj)) return null;
  const { license, licenses } = JSON.parse(readFileSync(pj, "utf8"));
  return license ?? licenses?.map((l) => l.type ?? l).join(" OR ") ?? null;
}

export function check(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const bad = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/") || entry.link) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const license = licenseOf(root, path, entry);
    if (license && allowed(license)) continue;
    if (reviewedName(name)) continue;
    bad.push(`${name}@${entry.version}: ${license ?? "no licence field"}`);
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = check(process.cwd());
  if (bad.length) {
    console.error(
      `Licences outside the allowlist in scripts/check-licenses.mjs:\n  ${bad.join("\n  ")}\n` +
        "Review the terms, then add the id to ALLOWED or the package to REVIEWED, and update docs/third-party.md.",
    );
    process.exit(1);
  }
  console.log("All npm licences are on the allowlist.");
}
