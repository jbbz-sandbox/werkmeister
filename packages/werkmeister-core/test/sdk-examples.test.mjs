// SW-749: every `@example` in core's TSDoc renders on werkmeister.io/sdk, so each must
// type-check against the built SDK. They are never run: some need the daemon or Docker.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const core = fileURLToPath(new URL("..", import.meta.url));
const src = join(core, "src");

/** Each `@example`'s ```ts fence in src/ and its subfolders, as [label, code]. */
function examples() {
  const out = [];
  for (const f of readdirSync(src, { recursive: true }).filter((n) => n.endsWith(".ts"))) {
    for (const [, body] of readFileSync(join(src, f), "utf8").matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
      const text = body.replace(/^[ \t]*\* ?/gm, "");
      for (const [, code] of text.matchAll(/@example[^\n]*\n```ts\n([\s\S]*?)```/g)) {
        out.push([`${f.replace(/\.ts$/, "").replaceAll("/", "_")}-${out.length}`, code]);
      }
    }
  }
  return out;
}

test("every SDK example imports werkmeister-core/sdk and type-checks against the built SDK", async () => {
  const found = examples();
  // 45 SDK exports, one example each at least: fewer means the extraction broke or one was dropped.
  assert.ok(found.length >= 45, `found ${found.length} examples, expected at least 45`);
  assert.deepEqual(
    found.filter(([, c]) => !c.includes('from "werkmeister-core/sdk"')).map(([l]) => l),
    [],
  );
  const dir = mkdtempSync(join(tmpdir(), "sdk-examples-"));
  try {
    for (const [label, code] of found) writeFileSync(join(dir, `${label}.ts`), code);
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "nodenext",
          moduleResolution: "nodenext",
          types: ["node"],
          typeRoots: [join(core, "node_modules/@types")],
          paths: { "werkmeister-core/sdk": [join(core, "dist/sdk.d.ts")] },
        },
        include: ["*.ts"],
      }),
    );
    const tsc = join(core, "node_modules/.bin/tsc");
    const r = await promisify(execFile)(tsc, ["-p", dir]).catch((e) => e);
    assert.equal(r.code ?? 0, 0, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
