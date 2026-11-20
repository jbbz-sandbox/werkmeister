#!/usr/bin/env node
/**
 * Before `changeset publish` (SW-711): every public workspace package must already exist on npm.
 * Trusted publishing can't create a package, so a release that adds one used to publish the rest,
 * tag them, and fail on the new one (release run 43532778364). This publishes nothing instead and
 * prints the bootstrap steps.
 *
 * shortcut: checks existence only. Reading a package's trusted-publisher config needs an owner
 * token, and the release job has only OIDC. A package with no trust config still fails at publish.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * @param {{ name: string, private?: boolean }[]} pkgs
 * @param {(name: string) => { status: number | null, stderr: string }} view `npm view <name> name`
 * @returns {{ name: string, why: string }[]} the public packages npm doesn't have, with why
 */
export function missingOnNpm(pkgs, view) {
  const missing = [];
  for (const { name, private: priv } of pkgs) {
    if (priv) continue;
    const r = view(name);
    if (r.status === 0) continue;
    const why = /\bE404\b/.test(r.stderr)
      ? "not on npm (E404)"
      : `npm view failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.status}`}`;
    missing.push({ name, why });
  }
  return missing;
}

const BOOTSTRAP = (
  name,
) => `  ${name}: publish a 0.0.0 placeholder by hand, make this workflow its trusted publisher, then rerun the release:
    npm publish --access public   (from a copy of the package at version 0.0.0)
    npm trust github ${name} --file ci.yml --repo jbbz-sandbox/werkmeister --allow-publish
    npm deprecate ${name}@0.0.0 "placeholder"
  (README.md § Releasing)`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkgs = JSON.parse(
    execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { encoding: "utf8" }),
  );
  const missing = missingOnNpm(pkgs, (name) =>
    spawnSync("npm", ["view", name, "name"], { encoding: "utf8" }),
  );
  if (missing.length) {
    console.error("check-npm-packages: publishing nothing; these packages are not on npm yet:");
    for (const m of missing)
      console.error(
        `- ${m.name}: ${m.why}${m.why.startsWith("not on npm") ? `\n${BOOTSTRAP(m.name)}` : ""}`,
      );
    process.exit(1);
  }
  console.log(`check-npm-packages: every public package is on npm`);
}
