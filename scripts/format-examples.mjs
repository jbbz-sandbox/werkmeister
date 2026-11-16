// SW-794: biome formats no code inside comments, so this pipes each TSDoc `@example` ```ts fence in
// werkmeister-core/src/**/*.ts (the files sdk-examples.test.mjs type-checks) through `biome format`.
// `node scripts/format-examples.mjs` rewrites them; `--check` lists unformatted files and exits 1.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages/werkmeister-core/src");

// From stdin with a .ts path, so biome.jsonc applies (2 spaces, 100 columns). A non-zero exit is code
// it cannot parse (a fragment): null, and the block stays as written. A biome that won't start rejects,
// so --check can't pass without checking.
function biome(code, bin) {
  return new Promise((done, fail) => {
    const child = execFile(
      bin,
      ["format", "--stdin-file-path=example.ts"],
      { cwd: ROOT },
      (err, stdout) => {
        if (err && typeof err.code !== "number")
          fail(new Error(`could not run ${bin}: ${err.message}`));
        else done(err ? null : stdout);
      },
    );
    child.stdin.on("error", () => {}); // a spawn failure also breaks the pipe; the callback reports it
    child.stdin.end(code);
  });
}

// `<indent>* @example` then `<indent>* ```ts`, the body, and `<indent>* ```` at the same indent.
const FENCE = /^([ \t]*)\* @example[^\n]*\n\1\* ```ts\n([\s\S]*?)^\1\* ```$/gm;

/** `text` with every `@example` fence formatted; `changed` and `skipped` (unparseable) count blocks. */
export async function formatExamples(text, bin = join(ROOT, "node_modules/.bin/biome")) {
  const blocks = [...text.matchAll(FENCE)];
  const formatted = await Promise.all(
    blocks.map(([, indent, body]) =>
      biome(body.replace(new RegExp(`^${indent}\\* ?`, "gm"), ""), bin).then((code) =>
        code === null
          ? null
          : `${code
              .replace(/\n$/, "")
              .split("\n")
              .map((l) => (l ? `${indent}* ${l}` : `${indent}*`))
              .join("\n")}\n`,
      ),
    ),
  );
  let out = "";
  let at = 0;
  let changed = 0;
  let skipped = 0;
  blocks.forEach((m, i) => {
    const bodyStart = m.index + m[0].indexOf("```ts\n") + "```ts\n".length;
    const bodyEnd = bodyStart + m[2].length;
    const body = formatted[i] ?? m[2];
    if (formatted[i] === null) skipped++;
    else if (body !== m[2]) changed++;
    out += text.slice(at, bodyStart) + body;
    at = bodyEnd;
  });
  return { text: out + text.slice(at), changed, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const unformatted = [];
  for (const f of readdirSync(SRC, { recursive: true }).filter((n) => n.endsWith(".ts"))) {
    const file = join(SRC, f);
    const before = readFileSync(file, "utf8");
    const { text, changed } = await formatExamples(before);
    if (!changed) continue;
    unformatted.push(`packages/werkmeister-core/src/${f}: ${changed} @example block(s)`);
    if (!check) writeFileSync(file, text);
  }
  if (check && unformatted.length) {
    console.error(
      `Unformatted @example code (run \`pnpm run format:examples\`):\n${unformatted.join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    `${check ? "checked" : "formatted"}: ${unformatted.length} file(s) ${check ? "unformatted" : "rewritten"}`,
  );
}
