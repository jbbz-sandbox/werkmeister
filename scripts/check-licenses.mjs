#!/usr/bin/env node
/**
 * SW-63: fail when any installed package carries a licence outside the allowlist
 * below, as `pnpm licenses list` reports it (run after `pnpm install`). See
 * docs/third-party.md § Checking npm licences.
 *
 * ponytail: pnpm lists only what this platform installed, so another platform's
 * optional binaries (@esbuild/darwin-arm64 …) go unchecked; each is a twin of a
 * listed package with the same terms. Check with `supportedArchitectures` set if
 * a twin's terms ever differ.
 */
import { execFileSync } from "node:child_process";
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

/** `listing` is `pnpm licenses list --json`: packages grouped by licence, "Unknown" when none. */
export function check(listing) {
  const bad = [];
  for (const [license, pkgs] of Object.entries(listing)) {
    if (allowed(license)) continue;
    for (const { name, versions } of pkgs) {
      if (reviewedName(name)) continue;
      bad.push(
        `${name}@${versions.join(", ")}: ${license === "Unknown" ? "no licence field" : license}`,
      );
    }
  }
  return bad.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = check(
    JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" })),
  );
  if (bad.length) {
    console.error(
      `Licences outside the allowlist in scripts/check-licenses.mjs:\n  ${bad.join("\n  ")}\n` +
        "Review the terms, then add the id to ALLOWED or the package to REVIEWED, and update docs/third-party.md.",
    );
    process.exit(1);
  }
  console.log("All npm licences are on the allowlist.");
}
