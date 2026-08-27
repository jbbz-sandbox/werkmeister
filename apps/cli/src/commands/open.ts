/**
 * sandbox open <feature> [--url URL | --path PATH] [--size W,H] [--position X,Y]
 *
 * Launch an isolated Chrome window pre-configured for a feature: sets the
 * ``X-Feature`` routing cookie and tags the window (title prefix + corner
 * badge) so it is unmistakably the window for this feature. No Playwright -- it
 * drives Chrome over the DevTools Protocol with a stdlib-only client.
 *
 * Routing only *resolves* if the feature is running (``sandbox up <feature>``);
 * otherwise the cookie is set but traffic falls through to the k8s baseline.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { parse as yamlParse } from "yaml";

import { openFeatureBrowser } from "../lib/browser.js";
import { ingressHostnames } from "../lib/feature_routing.js";
import { error, warn } from "../lib/config.js";
import { getSlot } from "sandbox-core/slots";

/**
 * Base URL for `--path`, from the registry rather than a literal.
 *
 * The routed host set is per-machine (ingress config + `feature_router:`
 * blocks), so a hardcoded host would open a page that may not exist. Returns
 * null when nothing is routed, letting the caller require an explicit `--url`.
 */
function defaultBase(): string | null {
  try {
    const hosts = ingressHostnames();
    return hosts.length > 0 ? `https://${hosts[0]}` : null;
  } catch {
    return null;
  }
}

function loadDotenv(start: string): Record<string, string> {
  let dir = start;
  while (true) {
    const envFile = path.join(dir, ".env");
    if (fs.existsSync(envFile) && fs.statSync(envFile).isFile()) {
      const result: Record<string, string> = {};
      for (let raw of fs.readFileSync(envFile, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) {
          continue;
        }
        const i = line.indexOf("=");
        result[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return result;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

function loadWorkspaceYaml(start: string): Record<string, any> {
  let dir = start;
  while (true) {
    for (const name of ["workspace.yml", "workspace.yaml"]) {
      const p = path.join(dir, ".sandbox", name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        let data: unknown;
        try {
          data = yamlParse(fs.readFileSync(p, "utf8"));
        } catch {
          return {};
        }
        return data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, any>)
          : {};
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());
  const workspaceYaml = loadWorkspaceYaml(process.cwd());

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  // Resolve the start URL: --url wins; else base + (--path, or workspace.yml
  // test_path, or .env TEST_PATH, or /).
  let url: string;
  if (args.url) {
    url = args.url as string;
  } else {
    let p =
      (args.path as string | null) ||
      workspaceYaml["test_path"] ||
      dotenv["TEST_PATH"] ||
      "/";
    if (!p.startsWith("/")) {
      p = "/" + p;
    }
    const base = defaultBase();
    if (base === null) {
      error(
        "No routed hosts in services.yaml (no service declares `feature_router:`) — " +
          "pass an explicit --url.",
      );
      return;
    }
    url = base + p;
  }

  if (getSlot(feature) === null) {
    warn(`Feature '${feature}' has no running slot — the cookie will be set, but`);
    warn(`traffic falls through to the k8s baseline. Start it with: sandbox up ${feature}`);
  }

  const code = await openFeatureBrowser(feature, url, {
    size: args.size as string,
    position: args.position as string | null,
  });
  if (code !== 0 && code !== 130) {
    process.exit(code);
  }
}
