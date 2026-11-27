import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookFiles } from "./render-pane.mjs";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");

// SW-1068: a hook module missing from the copy (hooks/gate-running.ts) stopped the render on main.
test("the render's plugin copy holds every hook module the pane's hooks import", () => {
  const copied = new Set(hookFiles());
  assert.ok(copied.has("hooks/register.tsx"));
  const missing = [...copied]
    .filter((f) => /\.tsx?$/.test(f))
    .flatMap((f) =>
      [...readFileSync(join(plugin, f), "utf8").matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]),
    )
    .filter((name) => ![".ts", ".tsx"].some((ext) => copied.has(`hooks/${name}${ext}`)));
  assert.deepEqual(missing, []);
});

test("hookFiles leaves out the tests and the render's own test", () => {
  const files = hookFiles();
  assert.deepEqual(
    files.filter((f) => f.endsWith(".test.ts") || f === "hooks/pane-render.ts"),
    [],
  );
});
