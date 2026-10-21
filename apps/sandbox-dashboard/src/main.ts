/**
 * The localhost workspaces dashboard: the browser page at `GET /` and the
 * `/api/*` bridge it calls. The MCP server is `apps/mcp` (`werkmeister mcp`);
 * this app only renders.
 *
 *   node dist/main.js            # http://localhost:$PORT/ (default 3001)
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { loadConfig } from "werkmeister-core/config";
import { watchPrs } from "werkmeister-core/pr_lifecycle";
import { createBrowserUiRouter } from "./lib/browser-ui.js";
import {
  createGithubEventsRouter,
  type RelayEvent,
  relayHandler,
  startGithubRelay,
} from "./lib/github-relay.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const log = (line: string) => console.error(`[workspaces] ${line}`);

/**
 * The GitHub relay, when `github_relay: { smee_url, secret }` is configured. Host only: a
 * `HOST=0.0.0.0` dashboard in a sandbox container would reap and resume from its own view.
 */
function startRelay(host: string, broadcast: (events: RelayEvent[]) => void) {
  const cfg = (loadConfig()["github_relay"] ?? {}) as { smee_url?: unknown; secret?: unknown };
  if (typeof cfg.smee_url !== "string" || typeof cfg.secret !== "string") return null;
  if (!LOOPBACK.has(host)) {
    log(`github relay: not started on HOST=${host} (host-only)`);
    return null;
  }
  return startGithubRelay({
    url: cfg.smee_url,
    secret: cfg.secret,
    onEvents: relayHandler({ watchPrs, broadcast, log }),
    log,
  });
}

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  // Loopback by default: `/api/tool` reaches host-level tools (Docker, VS Code,
  // kubectl, claude, workspace create/remove) with no authentication. HOST=0.0.0.0
  // exists for one case: a sandbox container, where the listener has to be
  // reachable through Docker's published port and the container network is the
  // isolation boundary.
  const host = process.env.HOST ?? "127.0.0.1";
  // createMcpExpressApp's Host-header check is the DNS-rebinding guard for a loopback bind.
  const app = createMcpExpressApp({ host });
  app.use(await createBrowserUiRouter());
  const githubEvents = createGithubEventsRouter();
  app.use(githubEvents.router);
  const relay = startRelay(host, githubEvents.broadcast);

  const httpServer = app.listen(port, host, (err?: Error) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.error(`[workspaces] workspaces dashboard: http://localhost:${port}/`);
  });

  const shutdown = () => {
    relay?.stop();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
