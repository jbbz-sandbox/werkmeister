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

import { launchFeatureWindow } from "sandbox-core/browser";
import { featureUrl } from "sandbox-core/feature_routing";
import { Colors, error, warn } from "../lib/config.js";
import { raw } from "sandbox-core/reporter";
import { loadDotenv } from "../lib/dotenv.js";
import { getSlot } from "sandbox-core/slots";

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
    const resolved = featureUrl(
      (args.path as string | null) || workspaceYaml["test_path"] || dotenv["TEST_PATH"] || "/",
    );
    if (resolved === null) {
      error(
        "No routed hosts in services.yaml (no service declares `feature_router:`) — " +
          "pass an explicit --url.",
      );
      return;
    }
    url = resolved;
  }

  if ((await getSlot(feature)) === null) {
    warn(`Feature '${feature}' has no running slot — the cookie will be set, but`);
    warn(`traffic falls through to the k8s baseline. Start it with: sandbox up ${feature}`);
  }

  const window = await launchFeatureWindow(feature, url, {
    size: args.size as string,
    position: args.position as string | null,
  });
  if (!window) {
    process.exit(1);
  }

  // Ctrl-C closes the window and cleans up. The handler lives here rather than
  // in the launcher because installing process-wide signal handlers is not
  // something a library may do to whoever imported it — the MCP server's
  // open-feature tool calls the same launcher and must keep its own shutdown.
  raw(`  ${Colors.CYAN}Ctrl-C${Colors.RESET} to close the window and clean up.\n\n`);
  const onSignal = () => window.stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let code: number;
  try {
    code = await window.supervise();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  // 130 means the window was closed by Ctrl-C. This was dead code until the
  // default handler stopped exiting out from under the listener above.
  if (code !== 0) {
    process.exit(code);
  }
}
