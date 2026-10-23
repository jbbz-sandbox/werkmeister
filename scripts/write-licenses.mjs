import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Packages that declare a licence in package.json but publish no licence text, here or
// upstream. Each gets a stub entry instead of failing the build; any other package
// without a licence file still fails it. Remove an entry when the package ships one.
const NO_LICENCE_FILE = {
  "split-ca": "https://github.com/bushong1/split-ca (author Charles Bushong)",
};

/**
 * SW-63, SW-74: a published bundle carries this repo's LICENSE and NOTICE, and the
 * licence file of every package the bundle inlined. Minified output keeps only the
 * `/*!` comments a few deps have, and MIT/ISC/BSD all require the full notice.
 *
 * `bundled` names the output files in the header; `outDir` is where the three files
 * land (vsce only finds LICENSE in the package root, npm's tarball takes dist/).
 */
export function writeLicenses({ outputs }, { outDir, bundled }) {
  const dirs = new Set();
  // Output-side inputs, not metafile.inputs: a package esbuild read but tree-shook
  // to nothing ships no code, so it needs no notice.
  for (const file of Object.values(outputs).flatMap((o) => Object.keys(o.inputs))) {
    const m = file.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (m) dirs.add(m[1]);
  }
  const notices = [...dirs].sort().map((dir) => {
    const { name, version, license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
    if (!file && NO_LICENCE_FILE[name]) {
      return `${name}@${version} (${license})\n\nThe package declares this licence in package.json but ships no licence text.\nSource: ${NO_LICENCE_FILE[name]}\n`;
    }
    if (!file) throw new Error(`${name}@${version} is bundled but ships no licence file`);
    return `${name}@${version} (${license})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
  });
  writeFileSync(
    join(outDir, "THIRD-PARTY-LICENSES.txt"),
    `Third-party packages bundled into ${bundled}, with their licence text. See NOTICE.\n\n` +
      [...new Set(notices)].join(`\n${"-".repeat(72)}\n\n`),
  );
  for (const f of ["LICENSE", "NOTICE"]) copyFileSync(join(ROOT, f), join(outDir, f));
}
