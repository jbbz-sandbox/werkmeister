/**
 * Telepresence OSS wrapper for `werkmeister intercept` (live testing in k8s dev).
 *
 * Design: this module is the single seam between the werkmeister CLI and the
 * interception tool — arg builders
 * are pure functions, subprocess execution goes through an injectable runner,
 * and every cluster coordinate comes from services.yaml. Swapping the backend
 * (e.g. to mirrord) means replacing this module only.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { workspaceForFeature } from "./compose.js";
import { getK8sContext, isFixture, loadServices } from "./config.js";
import { SandboxError } from "./errors.js";
import { loadFeatureRouters } from "./feature_routing.js";
import { ProcError, run, runAsync } from "./proc.js";
import { info, warn } from "./reporter.js";
import { getServicePort, getSlot } from "./slots.js";

export const MIN_VERSION: [number, number, number] = [2, 30, 0];

/**
 * Homebrew formula for the OSS client, used by `werkmeister setup`.
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
    } catch {}
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

/**
 * The async sibling of {@link Runner}. `_run` is `spawnSync`, which blocks the
 * whole event loop of whatever imported this library -- fine for a CLI that is
 * about to exit, fatal for a server serving other requests meanwhile.
 */
export type AsyncRunner = (cmd: string[]) => Promise<[number, string]>;

/**
 * {@link _run}'s contract -- [returncode, combined output], no throw for a
 * missing binary or a timeout -- on top of {@link runAsync}.
 *
 * An abort is NOT flattened into a returncode: the caller asked for the work to
 * stop, so the ProcError propagates rather than being reported as a
 * telepresence failure.
 */
export async function runAsyncRunner(
  cmd: string[],
  signal?: AbortSignal,
  timeout = 120,
): Promise<[number, string]> {
  let res;
  try {
    res = await runAsync(cmd, { capture: true, timeout, signal });
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

/**
 * Whether something accepts connections on localhost:*port* within *timeoutMs*.
 *
 * Resolves false rather than rejecting or hanging: every caller only wants the
 * boolean, and a closed port is the expected answer, not an error.
 */
export function portOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "localhost");
  });
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
export function versionLt(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Return a human-readable problem with the telepresence client, or null if OK. */
export async function versionError(
  runner: AsyncRunner = (cmd) => runAsyncRunner(cmd),
): Promise<string | null> {
  if (which("telepresence") === null) {
    return `telepresence not found on PATH. ${INSTALL_HINT}`;
  }
  const [rc, out] = await runner(["telepresence", "version"]);
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

/**
 * No `--server` override for docker mode: 2.31 rewrites a loopback API server
 * address for the containerized daemon on its own (verified against OrbStack's
 * `https://127.0.0.1:26443`, which the daemon reports back as
 * `https://host.docker.internal:26443`). The intercept side is NOT symmetrical —
 * see {@link DAEMON_HOST_ADDRESS}.
 */
export function buildConnectArgs(context: string, namespace: string, docker = false): string[] {
  const args = ["telepresence", "connect"];
  if (docker) {
    args.push("--docker");
  }
  args.push("--context", context, "--namespace", namespace);
  return args;
}

/**
 * Where a containerized daemon reaches the intercept target.
 *
 * `--address` defaults to 127.0.0.1, which for `connect --docker` is the DAEMON
 * CONTAINER's loopback — nothing listens there, and the cluster sees the
 * intercept answer `{"error":"EOF"}` while the local container sits untouched on
 * the host. Verified live against OrbStack's k8s: with this address the
 * header-scoped request reaches the local port and unheadered traffic still
 * reaches the cluster workload.
 */
export const DAEMON_HOST_ADDRESS = "host.docker.internal";

/**
 * The name `connect --docker` gives its daemon (2.31, observed). Docker-mode
 * commands pass it as `--use`: any unqualified telepresence call (an older
 * `list -i` poller's implicit connect) starts a host user daemon beside it, and
 * with two daemons an unqualified command refuses to pick one (SW-12).
 */
export function dockerDaemonName(context: string, namespace: string): string {
  return `${context}-${namespace}-cn`;
}

export function buildInterceptArgs(
  deployment: string,
  localPort: number,
  portId: number,
  feature: string,
  docker = false,
): string[] {
  // --port <local>:<identifier>. *portId* is the Service port NUMBER (k8s_port),
  // NOT the port name: a Service commonly names its `targetPort` (the
  // ambient-mesh precondition, telepresenceio#3990) while leaving the Service
  // `port` itself unnamed, so `:http` returns "no interceptable port matching
  // port http" while the number resolves. Verified live in the Phase-0 spike.
  // --mount false: singular in 2.30.1; disables the FUSE volume mount (we only route traffic).
  return [
    "telepresence",
    "intercept",
    deployment,
    "--port",
    `${localPort}:${portId}`,
    "--http-header",
    `x-feature=${feature}`,
    "--mount",
    "false",
    // Host mode leaves this alone: 127.0.0.1 is already the right laptop.
    ...(docker ? ["--address", DAEMON_HOST_ADDRESS] : []),
  ];
}

export function buildLeaveArgs(deployment: string): string[] {
  // `telepresence leave` is deprecated in 2.30.1 → `detach` (same positional shape:
  // `detach <attachment_name>`). Name kept as buildLeaveArgs to match the `--leave`
  // user-facing verb and its callers.
  return ["telepresence", "detach", deployment];
}

export function buildUninstallArgs(deployments: string[]): string[] {
  return ["telepresence", "uninstall", ...deployments];
}

/** `-s` stops every local daemon, containerized ones included (telepresence >= 2.18). */
export function buildQuitArgs(): string[] {
  return ["telepresence", "quit", "-s"];
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
 * The single definition of "interceptable", shared by `werkmeister intercept` (which
 * turns a non-null into a fatal error) and `werkmeister status --intercepts` (which
 * reports it). Returns the predicate half of a sentence — callers prefix the
 * service name, e.g. `'frontend' ${blocker}`.
 */
export function interceptBlocker(svcDef: unknown): string | null {
  if (typeof svcDef !== "object" || svcDef === null || Array.isArray(svcDef)) {
    return "is not defined in ~/.werkmeister/services.yaml.";
  }
  const svc = svcDef as Record<string, unknown>;
  const missing = missingClusterKeys(svc);
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

// k8s_port is the intercept --port identifier (the Service port NUMBER); see
// buildInterceptArgs re: why the number, not k8s_port_name.
const CLUSTER_KEYS = ["k8s_deployment", "k8s_namespace", "k8s_port"];

function missingClusterKeys(svc: Record<string, unknown>): string[] {
  return CLUSTER_KEYS.filter((k) => !svc[k]);
}

/**
 * Whether *svcDef* is a cluster service — one telepresence could ever intercept.
 *
 * False for CLIs, libraries and anything else with no Deployment, which a UI
 * shows no intercept control for (SW-21). True for a cluster service still
 * blocked on k8s_port_name: that one keeps a disabled control with its reason.
 */
export function isRemoteService(svcDef: unknown): boolean {
  return (
    typeof svcDef === "object" &&
    svcDef !== null &&
    !Array.isArray(svcDef) &&
    missingClusterKeys(svcDef as Record<string, unknown>).length === 0
  );
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
  /** False only when the binary is missing; a too-old or broken client still counts. */
  installed: boolean;
  /** False when telepresence couldn't be asked (absent, disconnected, or errored). */
  available: boolean;
  /** The namespace the daemon is connected to, or null. */
  namespace: string | null;
  /** Deployment name → owning feature (null if unreadable). */
  intercepts: Map<string, string | null>;
}

/**
 * Read active intercepts. Never throws.
 *
 * No `which()` pre-check: a missing binary is ENOENT, which {@link _run} already
 * turns into rc 127 at effectively zero cost. Status runs before `list` because
 * `list` on a disconnected daemon implicitly connects — a daemon launch on every
 * status poll (SW-12). Upstream documents `user_daemon` as the host-mode status
 * key, which `parseConnectedNamespace` reads.
 */
export async function listIntercepts(
  runner: AsyncRunner = (cmd) => runAsyncRunner(cmd),
): Promise<InterceptState> {
  const none = new Map<string, string | null>();
  if (isFixture()) {
    return { installed: false, available: false, namespace: null, intercepts: none };
  }
  const [rc, out] = await runner(STATUS_ARGS);
  if (rc === 127) {
    return { installed: false, available: false, namespace: null, intercepts: none };
  }
  let namespace = parseConnectedNamespace(rc, out);
  let use: string[] = [];
  // Several daemons (see dockerDaemonName): read the one that is connected.
  for (const name of namespace === null ? daemonChoices(out) : []) {
    namespace = parseConnectedNamespace(...(await runner([...STATUS_ARGS, "--use", name])));
    if (namespace !== null) {
      use = ["--use", name];
      break;
    }
  }
  if (namespace === null) {
    return { installed: true, available: false, namespace, intercepts: none };
  }
  const [lrc, lout] = await runner([...buildListInterceptsArgs(), ...use]);
  if (lrc !== 0) {
    return { installed: true, available: false, namespace, intercepts: none };
  }
  return { installed: true, available: true, namespace, intercepts: parseInterceptList(lout) };
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
  return parseConnectedNamespace(...runner(STATUS_ARGS));
}

const STATUS_ARGS = ["telepresence", "status", "--format", "json"];

/** The daemon names in telepresence's "multiple daemons are running, please select a or b" refusal. */
function daemonChoices(out: string): string[] {
  const m = /please select (.+?) using the --use/.exec(out);
  return m ? m[1].split(/, | or /) : [];
}

/** The parse half of {@link connectedNamespace}, shared with the async path. */
function parseConnectedNamespace(rc: number, out: string): string | null {
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
export async function ensureConnected(
  context: string,
  namespace: string,
  docker = false,
  runner: AsyncRunner = (cmd) => runAsyncRunner(cmd),
): Promise<void> {
  if (isFixture()) return;
  const use = docker ? ["--use", dockerDaemonName(context, namespace)] : [];
  const current = parseConnectedNamespace(...(await runner([...STATUS_ARGS, ...use])));
  if (current === namespace) {
    return;
  }
  // Quit unconditionally before reconnecting: we only get here when the
  // daemon is bound elsewhere OR status couldn't be read (rc!=0 → null). In
  // both cases a stale/uncertain session must be cleared first; `quit -s` is
  // idempotent and harmless when nothing is connected.
  await runner(["telepresence", "quit", "-s"]);
  const [rc, out] = await runner(buildConnectArgs(context, namespace, docker));
  if (rc !== 0) {
    throw new Error(`telepresence connect failed: ${out || "no output"}`);
  }
}

/** SERVICES list from a workspace .env (same format `werkmeister up` reads). */
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
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

/**
 * Best-effort: leave the intercepts of *feature*'s local services.
 *
 * Called from `werkmeister down` — must never block teardown, so a missing
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
    const deployment = deploymentOf(registry[svc]);
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

/**
 * After *left* were detached, uninstall the traffic agent of each one no other
 * intercept still uses, and quit every local daemon when no intercept remains
 * (SW-42; SW-2 left an agent at ~27% CPU and duplicate daemons). An unreadable
 * intercept list does neither: guessing could end another feature's intercept.
 * Never throws for a telepresence failure; the leave itself already succeeded.
 */
export async function releaseIdleTelepresence(
  left: string[],
  runner: AsyncRunner = (cmd) => runAsyncRunner(cmd),
): Promise<{ uninstalled: string[]; quit: boolean }> {
  const result = { uninstalled: [] as string[], quit: false };
  if (!left.length) {
    return result;
  }
  // ponytail: `list -i` sees the connected namespace only, so an intercept in
  // another namespace doesn't hold off the quit. The registry uses one today.
  const [rc, out] = await runner(buildListInterceptsArgs());
  // parseInterceptList maps unparseable output to "no intercepts", which here
  // would quit someone else's daemons, so anything but a JSON array is unreadable.
  let listed: unknown = [];
  try {
    listed = out.trim() ? JSON.parse(out) : [];
  } catch {
    listed = null;
  }
  if (rc !== 0 || !Array.isArray(listed)) {
    warn("Could not read telepresence intercepts -- leaving traffic agents and daemons in place");
    return result;
  }
  const remaining = parseInterceptList(out);

  const idle = left.filter((d) => !remaining.has(d));
  if (idle.length) {
    const [urc, uout] = await runner(buildUninstallArgs(idle));
    if (urc === 0) {
      result.uninstalled = idle;
      info(`Uninstalled traffic agent(s): ${idle.join(", ")}`);
    } else {
      warn(`Could not uninstall traffic agent(s) ${idle.join(", ")}: ${uout || "no output"}`);
    }
  }

  if (remaining.size === 0) {
    const [qrc, qout] = await runner(buildQuitArgs());
    if (qrc === 0) {
      result.quit = true;
      info("Stopped telepresence daemons");
    } else {
      warn(`Could not stop telepresence daemons: ${qout || "no output"}`);
    }
  }
  return result;
}

/** The k8s deployment behind a services.yaml entry, or undefined. */
function deploymentOf(svcDef: unknown): string | undefined {
  return typeof svcDef === "object" && svcDef !== null && !Array.isArray(svcDef)
    ? (svcDef as Record<string, any>)["k8s_deployment"]
    : undefined;
}

/**
 * Validate *service* is one of *localServices* with full k8s coordinates, and
 * return its services.yaml definition.
 *
 * *localServices* is the caller's `SERVICES` list. It is passed in rather than
 * read from a workspace `.env` here because a `.env` is a cwd-shaped CLI
 * concern; a server calling this has already resolved which services it runs.
 */
function resolveServiceDef(service: string, localServices: string[]): Record<string, any> {
  if (!localServices.includes(service)) {
    throw new SandboxError(
      `'${service}' is not a local service of this workspace ` +
        `(SERVICES=${localServices.join(",") || "(none)"}). Add it to ` +
        "workspace.yml services and rerun `werkmeister init-workspace`.",
      "NOT_LOCAL",
    );
  }
  // Interceptability is defined once, in interceptBlocker, so `werkmeister status
  // --intercepts` reports exactly what this function enforces.
  const svcDef = loadServices()[service];
  const blocker = interceptBlocker(svcDef);
  if (blocker) {
    throw new SandboxError(`'${service}' ${blocker}`, "NOT_INTERCEPTABLE");
  }
  return svcDef;
}

export interface InterceptArgs {
  feature: string;
  service: string;
  /** The workspace's SERVICES list — the caller reads it, never this module. */
  localServices: string[];
  dockerDaemon?: boolean;
  signal?: AbortSignal;
}

export interface InterceptResult {
  service: string;
  context: string;
  namespace: string;
  deployment: string;
  localPort: number;
  /** The request header the intercept filters on (see buildInterceptArgs). */
  header: string;
  /** The service's cluster hostname, or null if it routes no ingress. */
  remoteHost: string | null;
}

/**
 * Start a header-scoped intercept of *service* pointing at the feature's local
 * container, and return the facts a caller needs to render or use it.
 *
 * Callable in-process: every failure is a coded {@link SandboxError} and every
 * subprocess goes through {@link runAsyncRunner}, so neither a bad request nor a
 * slow `telepresence connect` can take down a host that is serving other work.
 *
 * Argument validation runs BEFORE the version probe, unlike the command this
 * replaces. A caller that asked for a service it does not run should hear that,
 * not "install telepresence" — and the reordering means the cheap check never
 * spawns anything.
 */
export async function startIntercept(a: InterceptArgs): Promise<InterceptResult> {
  if (isFixture()) {
    throw new SandboxError("Intercepts are off under WERKMEISTER_FIXTURE.", "FIXTURE");
  }
  const svcDef = resolveServiceDef(a.service, a.localServices);
  const runner: AsyncRunner = (cmd) => runAsyncRunner(cmd, a.signal);

  const problem = await versionError(runner);
  if (problem) {
    throw new SandboxError(problem, "TELEPRESENCE_VERSION");
  }

  const slot = await getSlot(a.feature);
  if (slot === null) {
    throw new SandboxError(
      `Feature '${a.feature}' has no allocated slot — run \`werkmeister up ${a.feature}\` first.`,
      "NOT_RUNNING",
    );
  }
  const localPort = getServicePort(slot, svcDef["port_offset"] ?? 0);
  if (!(await portOpen(localPort))) {
    throw new SandboxError(
      `${a.service} is not listening on localhost:${localPort} — ` +
        `run \`werkmeister up ${a.feature}\` first (the local container is the intercept target).`,
      "PORT_CLOSED",
    );
  }

  const context = getK8sContext();
  const namespace = svcDef["k8s_namespace"];
  const deployment = svcDef["k8s_deployment"];

  info(`Connecting to ${namespace} on ${context}...`);
  await ensureConnected(context, namespace, Boolean(a.dockerDaemon), runner);

  info(`Intercepting ${deployment} → localhost:${localPort} (x-feature=${a.feature})...`);
  const [rc, out] = await runner([
    ...buildInterceptArgs(
      deployment,
      localPort,
      svcDef["k8s_port"],
      a.feature,
      Boolean(a.dockerDaemon),
    ),
    ...(a.dockerDaemon ? ["--use", dockerDaemonName(context, namespace)] : []),
  ]);
  if (rc !== 0) {
    throw new SandboxError(
      `telepresence intercept failed: ${out || "no output"}`,
      "INTERCEPT_FAILED",
    );
  }

  return {
    service: a.service,
    context,
    namespace,
    deployment,
    localPort,
    header: FEATURE_HEADER,
    // The service's remote (cluster) hostname is where Caddy sends cluster-bound
    // traffic; a request there carrying the header (or the X-Feature cookie,
    // which Caddy copies into the header) is what the intercept reroutes to
    // your laptop.
    remoteHost: loadFeatureRouters()[a.service]?.remoteHostname ?? null,
  };
}

export interface LeaveInterceptArgs {
  feature: string;
  /** One service, or null/absent for every local service of the feature. */
  service?: string | null;
  localServices: string[];
  /** Leave through the containerized daemon `startIntercept({ dockerDaemon })` connected. */
  dockerDaemon?: boolean;
  signal?: AbortSignal;
}

/**
 * End intercepts and return the deployments actually left.
 *
 * With *service* set this is strict — an unknown service or a failed detach
 * throws, because the caller named one thing and it did not happen. Without it
 * the sweep is best-effort, matching {@link leaveFeatureIntercepts}, which
 * `werkmeister down` calls where a failure must never block teardown.
 */
export async function leaveIntercept(a: LeaveInterceptArgs): Promise<string[]> {
  // Every call, the post-leave cleanup included, goes to the daemon the intercept used.
  const runnerIn =
    (namespace: string): AsyncRunner =>
    (cmd) =>
      runAsyncRunner(
        a.dockerDaemon ? [...cmd, "--use", dockerDaemonName(getK8sContext(), namespace)] : cmd,
        a.signal,
      );
  if (a.service) {
    const svcDef = resolveServiceDef(a.service, a.localServices);
    const deployment = svcDef["k8s_deployment"];
    const runner = runnerIn(svcDef["k8s_namespace"]);
    const [rc, out] = await runner(buildLeaveArgs(deployment));
    if (rc !== 0) {
      throw new SandboxError(
        `Could not leave intercept: ${out || "no output"}`,
        "INTERCEPT_FAILED",
      );
    }
    await releaseIdleTelepresence([deployment], runner);
    return [deployment];
  }
  const registry = loadServices();
  const left: string[] = [];
  // Releasing goes through the last service's daemon: the registry uses one
  // namespace today. The initial runner only ever sees an empty `left`, a no-op.
  let runner = runnerIn("default");
  for (const svc of a.localServices) {
    const deployment = deploymentOf(registry[svc]);
    if (!deployment) {
      continue;
    }
    runner = runnerIn(registry[svc]["k8s_namespace"] ?? "default");
    const [rc] = await runner(buildLeaveArgs(deployment));
    if (rc === 0) {
      left.push(deployment);
    }
  }
  await releaseIdleTelepresence(left, runner);
  return left;
}
