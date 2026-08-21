/**
 * Telepresence OSS wrapper for `sandbox intercept` (live testing in k8s dev).
 *
 * Design: this module is the single seam between the sandbox CLI and the
 * interception tool — arg builders
 * are pure functions, subprocess execution goes through an injectable runner,
 * and every cluster coordinate comes from services.yaml. Swapping the backend
 * (e.g. to mirrord) means replacing this module only.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadServices } from "./config.js";
import { workspaceForFeature } from "./docker.js";
import { ProcError, run } from "sandbox-core/proc";

export const MIN_VERSION: [number, number, number] = [2, 30, 0];

/**
 * Homebrew formula for the OSS client, used by `sandbox setup`.
 *
 * Note the tap: `telepresenceio/telepresence` (upstream's own) ships the
 * `-oss` formula at a current version. The `datawire/blackbird` tap does NOT —
 * it stops at 2.19.x, below MIN_VERSION and too old for ambient mode — which is
 * why an earlier iteration of this module concluded brew was unusable and
 * hardcoded the direct download below. Setup still verifies the installed
 * version after brew runs and falls back to DOWNLOAD_HINT if the formula
 * somehow yields something older.
 */
export const BREW_FORMULA = "telepresenceio/telepresence/telepresence-oss";

/** Fallback when brew is unavailable or its formula is too old. */
export const DOWNLOAD_HINT =
  "curl -fL https://github.com/telepresenceio/telepresence/releases/latest/download/" +
  "telepresence-darwin-arm64 -o /opt/homebrew/bin/telepresence " +
  "&& chmod +x /opt/homebrew/bin/telepresence";

export const INSTALL_HINT =
  `Install Telepresence OSS >= ${MIN_VERSION.join(".")} with ` +
  `\`brew install ${BREW_FORMULA}\`, or by direct release download: ${DOWNLOAD_HINT}`;

export type Runner = (cmd: string[]) => [number, string];

/** shutil.which equivalent: first executable *cmd* on PATH, or null. */
function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Run *cmd*, returning [returncode, combined output]. Never throws. */
export function _run(cmd: string[], timeout = 120): [number, string] {
  let res;
  try {
    res = run(cmd, { capture: true, timeout });
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") {
      return [127, `${cmd[0]}: command not found`];
    }
    if (e instanceof ProcError && e.code === "ETIMEDOUT") {
      return [124, `${cmd.join(" ")}: timed out after ${timeout}s`];
    }
    throw e;
  }
  return [res.status, ((res.stdout || "") + (res.stderr || "")).trim()];
}

/** Extract the first vX.Y.Z in *output* as an int tuple, or null. */
export function parseVersion(output: string): [number, number, number] | null {
  const match = /v(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) {
    return null;
  }
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

/** Component-wise less-than for a (major, minor, patch) triple. */
export function versionLt(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Return a human-readable problem with the telepresence client, or null if OK. */
export function versionError(runner: Runner = _run): string | null {
  if (which("telepresence") === null) {
    return `telepresence not found on PATH. ${INSTALL_HINT}`;
  }
  const [rc, out] = runner(["telepresence", "version"]);
  const version = parseVersion(out);
  if (rc !== 0 || version === null) {
    const first = out ? out.split("\n")[0] : "no output";
    return `could not determine telepresence version (${first}). ${INSTALL_HINT}`;
  }
  if (versionLt(version, MIN_VERSION)) {
    const have = version.join(".");
    const need = MIN_VERSION.join(".");
    return `telepresence ${have} is too old (need >= ${need}). ${INSTALL_HINT}`;
  }
  return null;
}

export function buildConnectArgs(context: string, namespace: string, docker = false): string[] {
  const args = ["telepresence", "connect"];
  if (docker) {
    args.push("--docker");
  }
  args.push("--context", context, "--namespace", namespace);
  return args;
}

export function buildInterceptArgs(
  deployment: string,
  localPort: number,
  portId: number,
  feature: string,
): string[] {
  // --port <local>:<identifier>. *portId* is the Service port NUMBER (k8s_port),
  // NOT the port name: a Service commonly names its `targetPort` (the
  // ambient-mesh precondition, telepresenceio#3990) while leaving the Service
  // `port` itself unnamed, so `:http` returns "no interceptable port matching
  // port http" while the number resolves. Verified live in the Phase-0 spike.
  // --mount false: singular in 2.30.1; disables the FUSE volume mount (we only route traffic).
  return [
    "telepresence", "intercept", deployment,
    "--port", `${localPort}:${portId}`,
    "--http-header", `x-feature=${feature}`,
    "--mount", "false",
  ];
}

export function buildLeaveArgs(deployment: string): string[] {
  // `telepresence leave` is deprecated in 2.30.1 → `detach` (same positional shape:
  // `detach <attachment_name>`). Name kept as buildLeaveArgs to match the `--leave`
  // user-facing verb and its callers.
  return ["telepresence", "detach", deployment];
}

/** The header the CLI scopes every intercept by (see buildInterceptArgs). */
export const FEATURE_HEADER = "x-feature";

export function buildListInterceptsArgs(): string[] {
  // `-i` narrows the workload list to *intercepted* workloads only, so presence
  // in the result IS the answer — no discriminator field to sniff on the
  // unfiltered list. (`--output json` is deprecated in 2.30.1 → `--format`.)
  return ["telepresence", "list", "-i", "--format", "json"];
}

/**
 * Why *service* can't be intercepted, or null if it can.
 *
 * The single definition of "interceptable", shared by `sandbox intercept` (which
 * turns a non-null into a fatal error) and `sandbox status --intercepts` (which
 * reports it). Returns the predicate half of a sentence — callers prefix the
 * service name, e.g. `'frontend' ${blocker}`.
 */
export function interceptBlocker(svcDef: unknown): string | null {
  if (typeof svcDef !== "object" || svcDef === null || Array.isArray(svcDef)) {
    return "is not defined in ~/.sandbox/services.yaml.";
  }
  const svc = svcDef as Record<string, unknown>;
  // k8s_port is the intercept --port identifier (the Service port NUMBER); see
  // buildInterceptArgs re: why the number, not k8s_port_name.
  const missing = ["k8s_deployment", "k8s_namespace", "k8s_port"].filter((k) => !svc[k]);
  if (missing.length) {
    return `has no ${missing.join("/")} in services.yaml — not interceptable.`;
  }
  if (!svc["k8s_port_name"]) {
    return (
      "has no k8s_port_name in services.yaml. Interception under Istio ambient " +
      "requires a NAMED Service targetPort; add the port name there once the " +
      "service's manifests are fixed."
    );
  }
  return null;
}

/**
 * Active intercepts from *stdout* of {@link buildListInterceptsArgs}, as
 * deployment name → the feature owning it (the `x-feature` header filter), or
 * null when that filter can't be read.
 *
 * A deployment is present iff it is intercepted. Any parse miss yields an empty
 * map — intercept state is decoration on a status view, never worth an error.
 */
export function parseInterceptList(stdout: string): Map<string, string | null> {
  const found = new Map<string, string | null>();
  const text = String(stdout || "").trim();
  if (!text) {
    return found;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return found;
  }
  if (!Array.isArray(data)) {
    return found;
  }
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const workload = entry as Record<string, any>;
    const name = workload["name"];
    const infos = workload["intercept_info"];
    if (typeof name !== "string" || !name || !Array.isArray(infos) || !infos.length) {
      continue;
    }
    found.set(name, featureOf(infos[0]));
  }
  return found;
}

/** The `x-feature` header filter value of one intercept_info entry, or null. */
function featureOf(info: unknown): string | null {
  if (typeof info !== "object" || info === null) return null;
  const filters = (info as Record<string, any>)["spec"]?.["header_filters"];
  if (typeof filters !== "object" || filters === null) return null;
  // Telepresence echoes the header name as given; `--http-header x-feature=…`
  // comes back lowercase in 2.30.1, but match case-insensitively regardless.
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if (key.toLowerCase() === FEATURE_HEADER && typeof value === "string") {
      return value;
    }
  }
  return null;
}

export interface InterceptState {
  /** False when telepresence couldn't be asked at all (absent, or errored). */
  available: boolean;
  /** Deployment name → owning feature (null if unreadable). */
  intercepts: Map<string, string | null>;
}

/**
 * Read active intercepts. Never throws.
 *
 * No `which()` pre-check: a missing binary is ENOENT, which {@link _run} already
 * turns into rc 127 at effectively zero cost — so "telepresence not installed"
 * and "telepresence failed" collapse into one `available: false` branch.
 */
export function listIntercepts(runner: Runner = _run): InterceptState {
  const [rc, out] = runner(buildListInterceptsArgs());
  if (rc !== 0) {
    return { available: false, intercepts: new Map() };
  }
  return { available: true, intercepts: parseInterceptList(out) };
}

/**
 * The namespace the user daemon is connected to, or null if disconnected.
 *
 * Any parse miss is treated as disconnected — the caller then (re)connects,
 * which is idempotent-safe. Shape verified against the Phase-0 spike's saved
 * `telepresence status --format json`: the
 * connected daemon is the top-level `daemon` object in 2.30.1 (docker mode). We
 * also check `user_daemon` as a fallback — the host-mode shape couldn't be
 * captured live (root-daemon install needs interactive sudo), and a wrong guess
 * only costs a redundant reconnect, never correctness.
 */
export function connectedNamespace(runner: Runner = _run): string | null {
  const [rc, out] = runner(["telepresence", "status", "--format", "json"]);
  if (rc !== 0) {
    return null;
  }
  let data: Record<string, any>;
  try {
    data = JSON.parse(out);
  } catch {
    return null;
  }
  const daemon = data["daemon"] || data["user_daemon"] || {};
  if (daemon["status"] === "Connected" || daemon["running"]) {
    return daemon["namespace"] || null;
  }
  return null;
}

/**
 * Connect the telepresence daemon to *namespace*, reusing a live session.
 *
 * A session bound to a different namespace is quit first — telepresence
 * binds one namespace per connect, and a stale binding intercepts nothing.
 */
export function ensureConnected(
  context: string,
  namespace: string,
  docker = false,
  runner: Runner = _run,
): void {
  const current = connectedNamespace(runner);
  if (current === namespace) {
    return;
  }
  // Quit unconditionally before reconnecting: we only get here when the
  // daemon is bound elsewhere OR status couldn't be read (rc!=0 → null). In
  // both cases a stale/uncertain session must be cleared first; `quit -s` is
  // idempotent and harmless when nothing is connected.
  runner(["telepresence", "quit", "-s"]);
  const [rc, out] = runner(buildConnectArgs(context, namespace, docker));
  if (rc !== 0) {
    throw new Error(`telepresence connect failed: ${out || "no output"}`);
  }
}

/** SERVICES list from a workspace .env (same format `sandbox up` reads). */
function servicesFromEnv(envPath: string): string[] {
  let text: string;
  try {
    if (!fs.statSync(envPath).isFile()) return [];
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return [];
  }
  for (let line of text.split("\n")) {
    line = line.trim();
    if (line.startsWith("SERVICES=")) {
      const value = line.slice(line.indexOf("=") + 1);
      return value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * Best-effort: leave the intercepts of *feature*'s local services.
 *
 * Called from `sandbox down` — must never block teardown, so a missing
 * binary, missing workspace, or failed leave is silently skipped. Returns
 * the deployments actually left.
 */
export function leaveFeatureIntercepts(feature: string, runner: Runner = _run): string[] {
  if (which("telepresence") === null) {
    return [];
  }
  const workspace = workspaceForFeature(feature);
  if (workspace === null) {
    return [];
  }
  const services = servicesFromEnv(path.join(workspace, ".env"));
  if (!services.length) {
    return [];
  }
  const registry = loadServices();
  const left: string[] = [];
  for (const svc of services) {
    const svcDef = registry[svc];
    const deployment =
      typeof svcDef === "object" && svcDef !== null && !Array.isArray(svcDef)
        ? svcDef["k8s_deployment"]
        : undefined;
    if (!deployment) {
      continue;
    }
    const [rc] = runner(buildLeaveArgs(deployment));
    if (rc === 0) {
      left.push(deployment);
    }
  }
  return left;
}
