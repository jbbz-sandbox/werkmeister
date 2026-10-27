/**
 * The shared secret that stands between a container and the host's Docker
 * daemon, and the single predicate that decides whether a request carries it.
 *
 * 32 random bytes as hex in `~/.werkmeister/mcp-token`, mode 0600, created on first
 * start. The container gets it through its environment (`WERKMEISTER_MCP_TOKEN`),
 * never through the `.mcp.json` that lives in a git worktree.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { dotDir } from "werkmeister-core/config";

export function tokenPath(): string {
  return path.join(dotDir(os.homedir()), "mcp-token");
}

/** Read the token, creating it on first start. */
export function readOrCreateToken(): string {
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) {
      // `mode` on writeFileSync only applies at creation, so a file that
      // somehow ended up group/world-readable (a permissive umask, a manual
      // edit) would stay that way silently. Re-assert it on every read.
      // Best-effort: a chmod failure (e.g. read-only filesystem) shouldn't
      // take the whole server down over a permission bit it can't fix
      // either way — the token check itself is unaffected.
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // best-effort — see comment above
      }
      return existing;
    }
  } catch {
    // absent — fall through and create it
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * May this request proceed?
 *
 * One predicate rather than a per-route flag: a token is REQUIRED whenever the
 * bind is not loopback, and a token that is present is always checked — so a
 * host stdio/loopback client needs no configuration, and a container-reachable
 * bind cannot be left open by forgetting a flag somewhere.
 *
 * The length check precedes `timingSafeEqual`, which throws on unequal-length
 * buffers.
 */
export function authorized(header: string | undefined, token: string, host: string): boolean {
  if (header === undefined) {
    return isLoopback(host);
  }
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match) {
    return false;
  }
  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
