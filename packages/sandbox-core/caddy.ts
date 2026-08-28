/**
 * Caddy reverse proxy management for the developer sandbox.
 *
 * Caddy runs as a Docker container (part of shared-infra) and routes traffic
 * to the correct feature's containers based on the X-Feature header/cookie.
 */

import * as fs from "node:fs";

import { Colors } from "./colors.js";
import { infraRoot, sandboxRoot } from "./config.js";
import { copyFileToContainer, execCapture } from "./docker.js";
import { ProcError, run } from "./proc.js";
import { error, info, raw, success, warn } from "./reporter.js";

export const CADDY_CONTAINER = "sandbox-caddy";
export const CADDY_CONTAINER_PATH = "/tmp/Caddyfile";

// Matches a `reverse_proxy` directive start, bare or block-form.
const _REVERSE_PROXY_RE = /\breverse_proxy\b/g;

// Matches a line opening a `handle` / `handle_path` block, capturing the
// directive name and its (possibly empty) path/matcher argument.
const _HANDLE_OPEN_RE = /^\s*(handle(?:_path)?)\b\s*([^{]*)\{\s*$/;

// Matches a full inline `handle` / `handle_path` block written on a single
// line (e.g. `handle /foo/* { reverse_proxy foo:8080 }`) -- the exact
// route-drop signature documented in this repo's CLAUDE.md that
// `_HANDLE_OPEN_RE` cannot see, since it only matches lines ending in "{".
const _HANDLE_INLINE_RE = /^\s*(handle(?:_path)?)\b\s*([^{]*)\{.*\}\s*$/;

function _infraComposeFile(): string {
  return `${infraRoot()}/compose/shared-infra.yml`;
}

/** Everything before the first `#` in *line*. */
function _stripComment(line: string): string {
  const i = line.indexOf("#");
  return i === -1 ? line : line.slice(0, i);
}

/**
 * Blank out braces that delimit no block.
 *
 * Caddy placeholders (`{re.xf.1}`, `{args[0]}`) and quoted strings carry braces
 * that open and close nothing. Only the `{`/`}` surviving this belong to the
 * block-depth counter.
 *
 * ponytail: regex-level, so it assumes placeholders hold no whitespace and do
 * not nest — true of every placeholder this repo's templates emit. A real
 * tokenizer if that stops holding.
 */
function _stripBraceNoise(code: string): string {
  return code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\{[^{}\s]*\}/g, "");
}

/**
 * Count distinct ``reverse_proxy`` leaf handlers in a ``caddy adapt`` JSON dict.
 *
 * Recursively descends through the ``routes`` of every server under
 * ``apps.http.servers``, following any ``subroute`` handler's nested
 * ``routes``, and adds exactly 1 for every ``reverse_proxy`` handler
 * encountered at any depth. Returns 0 (never raises) when expected keys are
 * missing or empty.
 */
export function countCompiledRoutes(adaptJson: Record<string, any>): number {
  function walkRouteBlocks(routeBlocks: any[]): number {
    let total = 0;
    for (const routeBlock of routeBlocks) {
      if (typeof routeBlock !== "object" || routeBlock === null || Array.isArray(routeBlock)) {
        continue;
      }
      for (const handler of routeBlock["handle"] ?? []) {
        if (typeof handler !== "object" || handler === null || Array.isArray(handler)) {
          continue;
        }
        const handlerType = handler["handler"];
        if (handlerType === "subroute") {
          total += walkRouteBlocks(handler["routes"] ?? []);
        } else if (handlerType === "reverse_proxy") {
          total += 1;
        }
      }
    }
    return total;
  }

  const servers = adaptJson?.["apps"]?.["http"]?.["servers"];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return 0;
  }
  let total = 0;
  for (const server of Object.values(servers)) {
    if (typeof server === "object" && server !== null && !Array.isArray(server)) {
      total += walkRouteBlocks((server as Record<string, any>)["routes"] ?? []);
    }
  }
  return total;
}

/**
 * Derive an expected route count directly from generated Caddyfile text.
 *
 * Counts ``reverse_proxy`` directive occurrences -- the same "one destination
 * = one count" unit that :func:`countCompiledRoutes` uses. Comments are
 * stripped before counting.
 */
export function computeExpectedRouteCount(caddyfileText: string): number {
  let total = 0;
  for (const line of caddyfileText.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const code = _stripComment(line);
    total += (code.match(_REVERSE_PROXY_RE) ?? []).length;
  }
  return total;
}

/**
 * Structurally lint Caddyfile text for the genuine handle-vs-route drop signature.
 *
 * Returns a list of human-readable finding strings; empty list means no issues.
 */
export function lintCaddyfileStructure(caddyfileText: string): string[] {
  const findings: string[] = [];
  const lines = caddyfileText.split(/\r?\n/);

  let depth = 0;
  let currentSite = "(global)";
  const siteStack: string[] = [];
  // depth -> list of [lineNo, directive, arg, inRoute]
  const handleGroups = new Map<number, Array<[number, string, string, boolean]>>();
  const routeDepths = new Set<number>();

  function flushGroup(d: number): void {
    const group = handleGroups.get(d) ?? [];
    handleGroups.delete(d);
    if (group.length < 2) return;
    // Skip entirely if this depth is inside a `route { }` wrapper.
    if (routeDepths.has(d)) return;
    const bare = group.filter((g) => g[2] === "");
    const scoped = group.filter((g) => g[2] !== "");
    if (bare.length && scoped.length) {
      for (const [lineNo, directive] of bare) {
        findings.push(
          `${currentSite}: line ${lineNo}: bare unscoped '${directive} {' ` +
            "coexists with path-scoped sibling handle blocks (route-drop risk)",
        );
      }
    }
    // Duplicate matcher detection among scoped siblings.
    const seen = new Map<string, number>();
    for (const [lineNo, directive, arg] of scoped) {
      if (seen.has(arg)) {
        findings.push(
          `${currentSite}: line ${lineNo}: duplicate '${directive} ${arg}' ` +
            `matcher also used at line ${seen.get(arg)} (route-drop risk)`,
        );
      } else {
        seen.set(arg, lineNo);
      }
    }
  }

  for (let idx0 = 0; idx0 < lines.length; idx0++) {
    const idx = idx0 + 1;
    const rawLine = lines[idx0];
    const codeLine = _stripComment(rawLine);
    const stripped = codeLine.trim();

    // Track site-block name when entering a new top-level block.
    if (depth === 0 && stripped.endsWith("{") && !stripped.startsWith("#")) {
      const siteName = stripped.slice(0, -1).trim();
      siteStack.push(siteName ? siteName : "(global)");
      currentSite = siteStack[siteStack.length - 1];
    } else if (siteStack.length && stripped.endsWith("{")) {
      // nested block open, handled below by depth tracking
    }

    if (stripped.startsWith("route") && /^route\b.*\{\s*$/.test(stripped)) {
      routeDepths.add(depth + 1);
    }

    const handleMatch = _HANDLE_OPEN_RE.exec(codeLine);
    if (handleMatch) {
      const directive = handleMatch[1];
      const arg = handleMatch[2].trim();
      if (!handleGroups.has(depth)) handleGroups.set(depth, []);
      handleGroups.get(depth)!.push([idx, directive, arg, routeDepths.has(depth)]);
    } else {
      const inlineMatch = _HANDLE_INLINE_RE.exec(codeLine);
      if (inlineMatch) {
        const directive = inlineMatch[1];
        const arg = inlineMatch[2].trim();
        if (!handleGroups.has(depth)) handleGroups.set(depth, []);
        handleGroups.get(depth)!.push([idx, directive, arg, routeDepths.has(depth)]);
        // Self-contained on one line: its own "{" and "}" cancel out.
        continue;
      }
    }

    // Count real block delimiters only. Treating every line ending in `}` as a
    // close let a placeholder (`header_up X-Feature {re.xf.1}`) decrement depth
    // mid-block, which split sibling `handle` groups across two depths and
    // silently disarmed both guards above — on files with the exact defect they
    // exist to catch.
    const braces = _stripBraceNoise(stripped);
    for (let c = 0; c < (braces.match(/\{/g) ?? []).length; c++) {
      depth += 1;
    }
    for (let c = 0; c < (braces.match(/\}/g) ?? []).length; c++) {
      if (handleGroups.has(depth)) {
        flushGroup(depth);
      }
      routeDepths.delete(depth);
      depth = Math.max(depth - 1, 0);
      if (depth === 0 && siteStack.length) {
        siteStack.pop();
        currentSite = siteStack.length ? siteStack[siteStack.length - 1] : "(global)";
      }
    }
  }

  // Flush any remaining open groups (malformed/unterminated input safety net).
  for (const d of [...handleGroups.keys()]) {
    flushGroup(d);
  }

  return findings;
}

/**
 * Copy the host Caddyfile into the running Caddy container.
 *
 * Returns True on success.
 */
export async function cpCaddyfileToContainer(
  hostPath: string,
  container: string = CADDY_CONTAINER,
  containerPath: string = CADDY_CONTAINER_PATH,
): Promise<boolean> {
  info(`Copying Caddyfile into container: ${hostPath} -> ${container}:${containerPath}`);
  try {
    await copyFileToContainer(container, hostPath, containerPath);
    return true;
  } catch (e) {
    error(`Copying the Caddyfile failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Run ``caddy adapt`` inside the container and count compiled routes.
 *
 * Returns ``[adaptSucceeded, routeCount, stderrOrEmpty]``.
 */
export async function adaptAndCountRoutes(
  container: string = CADDY_CONTAINER,
  containerPath: string = CADDY_CONTAINER_PATH,
): Promise<[boolean, number, string]> {
  let result;
  try {
    result = await execCapture(container, ["caddy", "adapt", "--config", containerPath]);
  } catch (e) {
    return [false, 0, (e as Error).message];
  }

  if (result.exitCode !== 0) {
    return [false, 0, result.stderr.trim()];
  }

  let adaptJson;
  try {
    adaptJson = JSON.parse(result.stdout);
  } catch (exc) {
    return [false, 0, `failed to parse caddy adapt output as JSON: ${exc}`];
  }

  return [true, countCompiledRoutes(adaptJson), ""];
}

/**
 * Run docker compose against the shared-infra compose file for caddy.
 *
 * Returns True on success.
 */
function _runCaddyCompose(args: string[], { capture = false }: { capture?: boolean } = {}): boolean {
  const composeFile = _infraComposeFile();
  const envFile = `${sandboxRoot()}/.env`;
  const cmd = ["docker", "compose", "--env-file", envFile, "-f", composeFile, ...args];
  info(`Running: ${cmd.join(" ")}`);

  let result;
  try {
    result = run(cmd, { capture, timeout: 60 });
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") {
      error("docker compose not found. Ensure Docker Desktop is installed.");
      return false;
    }
    if (e instanceof ProcError && e.code === "ETIMEDOUT") {
      error("Proxy command timed out after 60 seconds");
      return false;
    }
    throw e;
  }
  if (result.status !== 0) {
    const stderrText = capture ? result.stderr : "";
    error(`Proxy command failed (exit ${result.status})`);
    if (stderrText) {
      raw(`${Colors.DIM}${stderrText.trim()}${Colors.RESET}\n`);
    }
    return false;
  }
  return true;
}

/**
 * Reload the Caddy configuration inside the running container.
 *
 * Runs the cp -> lint(advisory) -> adapt+count -> compare -> reload pipeline.
 * Returns True on success.
 */
export async function reloadCaddy(): Promise<boolean> {
  const hostCaddyfile = `${infraRoot()}/proxy/Caddyfile`;

  info("Copying Caddyfile into Caddy container...");
  if (!(await cpCaddyfileToContainer(hostCaddyfile))) {
    error(`Failed to copy ${hostCaddyfile} into ${CADDY_CONTAINER}:${CADDY_CONTAINER_PATH}`);
    return false;
  }

  const caddyfileText = fs.readFileSync(hostCaddyfile, "utf8");

  const lintFindings = lintCaddyfileStructure(caddyfileText);
  for (const finding of lintFindings) {
    warn(`Structural lint: ${finding}`);
  }

  info("Validating config and counting compiled routes...");
  const [adaptOk, compiledCount, adaptErr] = await adaptAndCountRoutes();
  if (!adaptOk) {
    error(`caddy adapt failed -- not reloading: ${adaptErr}`);
    return false;
  }

  const expectedCount = computeExpectedRouteCount(caddyfileText);
  if (compiledCount < expectedCount) {
    error(
      `Route-count guard tripped: compiled ${compiledCount} routes, ` +
        `expected ${expectedCount} (from ${hostCaddyfile}) -- not reloading. ` +
        "This usually means the Caddyfile uses overlapping/unscoped `handle` " +
        "blocks instead of a `route` block.",
    );
    return false;
  }

  info(`Route count OK: ${compiledCount} compiled routes (expected >= ${expectedCount})`);

  info("Reloading Caddy configuration...");

  let result;
  try {
    result = await execCapture(CADDY_CONTAINER, [
      "caddy", "reload", "--config", CADDY_CONTAINER_PATH,
    ]);
  } catch (e) {
    error(`Caddy reload failed: ${(e as Error).message}`);
    return false;
  }
  if (result.exitCode !== 0) {
    // Reload command itself failed (not an adapt/count failure) -- try restart instead
    warn(`Caddy reload failed: ${result.stderr.trim()}`);
    warn(
      "Falling back to restarting the Caddy container; it reads the " +
        "bind-mounted /etc/caddy/Caddyfile which may lag behind the latest copy.",
    );
    info("Attempting to restart Caddy container instead...");
    return _runCaddyCompose(["restart", "caddy"], { capture: true });
  }
  success("Caddy configuration reloaded");
  return true;
}

/**
 * Start the Caddy reverse proxy container.
 *
 * Returns True on success.
 */
export function startCaddy(): boolean {
  info("Starting Caddy reverse proxy...");
  const ok = _runCaddyCompose(["up", "-d", "caddy"], { capture: true });
  if (ok) {
    success("Caddy reverse proxy started");
  }
  return ok;
}

/**
 * Stop the Caddy reverse proxy container.
 *
 * Returns True on success.
 */
export function stopCaddy(): boolean {
  info("Stopping Caddy reverse proxy...");
  const ok = _runCaddyCompose(["stop", "caddy"], { capture: true });
  if (ok) {
    success("Caddy reverse proxy stopped");
  }
  return ok;
}

/** Check if the Caddy container is running. */
export function isCaddyRunning(): boolean {
  const composeFile = _infraComposeFile();
  const cmd = ["docker", "compose", "-f", composeFile, "ps", "--status", "running", "-q", "caddy"];
  try {
    const result = run(cmd, { capture: true, timeout: 10 });
    return Boolean(result.stdout.trim());
  } catch (e) {
    if (e instanceof ProcError && (e.code === "ENOENT" || e.code === "ETIMEDOUT")) {
      return false;
    }
    throw e;
  }
}
