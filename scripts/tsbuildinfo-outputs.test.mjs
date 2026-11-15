import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
// shortcut: strips whole-line `//` comments only; switch to a JSONC parser if a config gains block or trailing comments.
const readJsonc = (p) =>
  JSON.parse(
    readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n"),
  );

const incrementalPackages = () =>
  ["packages", "apps"].flatMap((dir) =>
    readdirSync(join(root, dir))
      .map((name) => join(root, dir, name))
      .filter((pkg) => existsSync(join(pkg, "tsconfig.json")))
      .map((pkg) => ({
        name: readJsonc(join(pkg, "package.json")).name,
        opts: readJsonc(join(pkg, "tsconfig.json")).compilerOptions ?? {},
      }))
      .filter(({ opts }) => opts.incremental === true),
  );

// SW-753: turbo replays dist/ without running tsc; build-info left outside dist/ would survive the replay
// (or a hand-deleted dist/), and the next real tsc would leave stale or missing output.
test("every incremental package keeps its build-info inside the dist/ turbo caches", () => {
  const incremental = incrementalPackages();
  for (const name of ["werkmeister-core", "werkmeister-mcp"])
    assert.ok(
      incremental.some((p) => p.name === name),
      `${name} is not incremental`,
    );
  for (const { name, opts } of incremental)
    assert.match(
      opts.tsBuildInfoFile ?? "",
      /^(\.\/)?dist\//,
      `${name}: tsBuildInfoFile must be under dist/`,
    );
  assert.ok(readJsonc(join(root, "turbo.json")).tasks.build.outputs.includes("dist/**"));
});

// SW-766: without this ordering typecheck runs beside build again: a second tsc (~60 CPU-s per gate row) writing the same dist/tsconfig.tsbuildinfo at once.
test("core and MCP typecheck depend on their own build", () => {
  const rootTasks = readJsonc(join(root, "turbo.json")).tasks;
  const mcpTasks = readJsonc(join(root, "apps/werkmeister-mcp/turbo.json")).tasks;
  assert.ok(
    rootTasks["werkmeister-core#typecheck"]?.dependsOn?.includes("build"),
    'turbo.json: werkmeister-core#typecheck must dependOn "build"',
  );
  assert.ok(
    mcpTasks.typecheck?.dependsOn?.includes("build"),
    'apps/werkmeister-mcp/turbo.json: typecheck must dependOn "build"',
  );
});
