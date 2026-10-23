/**
 * SW-30: directories, package names and service ids say the same thing. When
 * they disagreed (SW-6 renamed the packages, not the directories), PR gate
 * filters, `--services` values and the mod's core lookup broke one by one.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DASHBOARD, MCP } from "werkmeister-core/web_servers";
import YAML from "yaml";

const REPO = path.resolve(fileURLToPath(import.meta.url), "../../../../../..");
// "cli" names the role, and installed shims, config.yaml and every generated compose file point at it.
const ROLE_NAMED = new Set(["apps/cli"]);

const workspaceDirs = ["apps", "packages"].flatMap((parent) =>
  fs
    .readdirSync(path.join(REPO, parent))
    .filter((d) => fs.existsSync(path.join(REPO, parent, d, "package.json")))
    .map((d) => `${parent}/${d}`),
);

describe("repo layout", () => {
  it.each(workspaceDirs.filter((d) => !ROLE_NAMED.has(d)))(
    "%s is named after its package",
    (dir) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, dir, "package.json"), "utf8"));
      expect(path.basename(dir)).toBe(pkg.name);
    },
  );

  it("names each service in this repo's registry fragment after its directory", () => {
    const { services } = YAML.parse(
      fs.readFileSync(path.join(REPO, ".sandbox", "services.yaml"), "utf8"),
    );
    for (const [id, def] of Object.entries<{ path: string }>(services)) {
      expect(fs.existsSync(path.join(REPO, def.path)), def.path).toBe(true);
      expect(path.basename(def.path)).toBe(id);
    }
  });

  it("finds the web servers' apps where web_servers.ts looks", () => {
    for (const app of [DASHBOARD, MCP]) {
      expect(fs.existsSync(path.join(REPO, "apps", app.dir, "package.json")), app.dir).toBe(true);
    }
  });
});
