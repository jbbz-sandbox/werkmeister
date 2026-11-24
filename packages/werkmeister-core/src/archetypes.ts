/**
 * Service archetype resolution — build-plan step 1 of
 * docs/jit-context-system.md (§4.1).
 *
 * An archetype is a named bundle in services.yaml's `archetypes:` registry
 * describing what a service *type* contributes to workspace generation:
 * standards modules today; MCP servers, test commands, and per-archetype
 * subagents in later build steps. A service opts in with `archetype: <name>`.
 *
 * Migration (§4.1): the shipped per-service
 * `standards: [key]` form stays valid — it normalizes here into an anonymous
 * archetype `{standards: [...]}` — so both forms coexist with no flag day.
 * Everything downstream reads through `resolveServiceArchetype` and never
 * touches the raw fields.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse as parseYaml } from "yaml";

import {
  type Archetype,
  type ArchetypeRegistry,
  dotDir,
  expandUser,
  getReposRoot,
  loadArchetypes,
  type ReposConfig,
  type ServiceEntry,
  type ServicesConfig,
  type StageRole,
  type StageText,
  sandboxHome,
  sandboxRoot,
  workspacesRoot,
} from "./config.js";
import { SandboxError } from "./errors.js";

const realPath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Host sources of *entry*'s bind mounts (named volumes skipped), symlinks resolved (`/var` → `/private/var` on macOS). */
const hostBinds = (entry: ServiceEntry | undefined) =>
  (entry?.extra_volumes ?? [])
    .map((spec) => spec.split(":")[0])
    .filter((src) => src.includes("/"))
    .map((src) => realPath(expandUser(src)));

const within = (p: string, dir: string) =>
  p === dir || p.startsWith(`${dir}${path.sep}`) || dir === "/";

/**
 * True when one of *entry*'s host binds is a docker socket (any path ending `docker.sock`, e.g. OrbStack's),
 * or the werkmeister home, the workspaces root or the repos root, or a parent of one. With *workspaceRoot*,
 * also anything else under those roots: another workspace, or a checkout a dev-linked CLI runs from.
 * SW-855: complete for docker (no TCP API on host.docker.internal), partial for the werkmeister daemon,
 * which any container holding the workspace's token reaches on :3002 (docs/context-strategies.md).
 */
export function hostAccess(entry: ServiceEntry | undefined, workspaceRoot?: string): boolean {
  const roots = [workspacesRoot(), getReposRoot()].map(realPath);
  const targets = ["/var/run/docker.sock", sandboxHome(), ...roots].map(realPath);
  // Both roots default to ~/workspace, so the workspace's own mount is under them.
  const own = workspaceRoot && realPath(workspaceRoot);
  return hostBinds(entry).some(
    (host) =>
      path.basename(host) === "docker.sock" ||
      targets.some((t) => within(t, host)) ||
      Boolean(own && roots.some((r) => within(host, r)) && !within(host, own)),
  );
}

// SW-854: what decides the container a start runs; compose runs the branch's (SW-337).
const START_FIELDS = [
  "command",
  "image",
  "build",
  "entrypoint",
  "archetype",
  "extra_volumes",
  "environment",
];

/** The start fields *branch*'s entry for *svc* changes from *registry*'s (SW-854, SW-891). */
export const changedStartFields = (
  registry: ServicesConfig,
  branch: ServicesConfig,
  svc: string,
): string[] =>
  START_FIELDS.filter(
    (k) =>
      !isDeepStrictEqual(
        (registry[svc] as Record<string, unknown> | undefined)?.[k],
        (branch[svc] as Record<string, unknown> | undefined)?.[k],
      ),
  );

/** True when *entry*'s container sees host path *p* at the same path (one of its binds covers it). */
export function seesHostPath(entry: ServiceEntry | undefined, p: string): boolean {
  const target = realPath(p);
  return hostBinds(entry).some((host) => within(target, host));
}

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return the normalized archetype dict for one service definition.
 *
 * Precedence: an explicit `archetype:` reference wins over legacy
 * `standards:` (declaring both is flagged by `validateServiceArchetypes`).
 * An unknown archetype name resolves to `null` — validation reports the
 * drift; resolution must not invent context. `null` also means "no
 * archetype": the service contributes only the universal base.
 */
export function resolveServiceArchetype(
  svcDef: ServiceEntry | null | undefined,
  archetypes?: ArchetypeRegistry | null,
): Archetype | null {
  if (!isDict(svcDef)) return null;
  const name = svcDef["archetype"];
  if (name !== undefined && name !== null) {
    if (archetypes === undefined || archetypes === null) archetypes = loadArchetypes();
    const arch = archetypes[name];
    return isDict(arch) ? arch : null;
  }
  const legacy = svcDef["standards"];
  if (legacy?.length) {
    return { standards: Array.from(legacy) };
  }
  return null;
}

/** The standards keys a service contributes, via its archetype. */
export function serviceStandards(
  svcDef: ServiceEntry | null | undefined,
  archetypes?: ArchetypeRegistry | null,
): string[] {
  const arch = resolveServiceArchetype(svcDef, archetypes);
  return Array.from(arch?.["standards"] ?? []);
}

/**
 * The test command for one service, run from its repo root.
 *
 * A per-service `test:` wins over the archetype's template — the command is
 * a property of the repo's tooling (nx vs turbo vs plain yarn), which the
 * archetype default cannot always know. The template's `{service}`
 * placeholder expands to the service name. `null` means no command is
 * registered anywhere; the caller must not invent one.
 */
export function serviceTestCommand(
  svcName: string,
  svcDef: ServiceEntry | null | undefined,
  archetypes?: ArchetypeRegistry | null,
): string | null {
  if (!isDict(svcDef) || serviceNoTests(svcDef) !== null) return null;
  const own = svcDef["test"];
  if (own) return String(own);
  const arch = resolveServiceArchetype(svcDef, archetypes);
  const template = arch?.["test"];
  if (!template) return null;
  return String(template).split("{service}").join(svcName);
}

/** The reason a service's `test: none` / `test: "none: <reason>"` gives (SW-119), or null for any other value. */
export function serviceNoTests(svcDef: ServiceEntry | null | undefined): string | null {
  const m = isDict(svcDef)
    ? /^none(?::\s*(.*))?$/i.exec(String(svcDef["test"] ?? "").trim())
    : null;
  return m ? m[1]?.trim() || "test: none" : null;
}

/**
 * How the agent runs *cmd* from the host: in the service's container, where the
 * worktree's `node_modules` live. werkmeister-context.md and the workspace's
 * `permissions.allow` rule both use it, so the rule matches what the agent runs.
 */
export function containerTestCommand(
  feature: string,
  svc: string,
  cmd: string,
  tempHome?: string,
): string {
  const quoted = `sh -c '${cmd.split("'").join(`'\\''`)}'`;
  // SW-769: a container holding the real ~/.werkmeister runs its tests under a temp HOME, as Validation says.
  return tempHome
    ? `docker exec -w /app ${feature}-${svc} ${tempHome} --no-wait ${quoted}`
    : `docker exec ${feature}-${svc} ${quoted}`;
}

/** True when *cmd* is simple commands joined only by `&&`: no group, pipe, `||`, `;`, `&`, newline or substitution. */
export function isPlainChain(cmd: string): boolean {
  return !/[|;&{}()`\n]|\$\(/.test(cmd.split("&&").join(""));
}

/**
 * The test command (after the repo's lint) as werkmeister-context.md prints it and its allow rule
 * matches it. Lint goes first so a format error fails in seconds, not after turbo's minutes (SW-636). One simple command is prefixed with *tempHome*; anything more goes through `sh -c`,
 * so every part runs under the temp HOME (`with-temp-home a && b` wraps only `a`) and a `{ …; }`
 * group is not a syntax error (SW-660).
 */
export function wrappedTestCommand(
  tempHome: string,
  test: string,
  lint?: string,
  repo?: string,
): string {
  const full = lint ? `${lint} && ${test}` : test;
  if (!tempHome) return full;
  // SW-652: from *repo*'s worktree (<ws>/<repo>; tempHome is <ws>/.werkmeister/bin/…), whatever the shell's cwd.
  const wrapper = repo ? `${tempHome} --cwd ${path.resolve(tempHome, "../../..", repo)}` : tempHome;
  if (isPlainChain(full) && !full.includes("&&")) return `${wrapper} ${full}`;
  return `${wrapper} sh -c '${full.split("'").join(`'\\''`)}'`;
}

/**
 * How to exercise a change to one service when it has no URL to hit.
 *
 * Same precedence as `serviceTestCommand`: a per-service `validate:` wins over
 * the archetype's, because the same archetype covers a library and a CLI.
 * Free text, so no `{service}` expansion. `null` means nothing is registered.
 */
export function serviceValidation(
  svcDef: ServiceEntry | null | undefined,
  archetypes?: ArchetypeRegistry | null,
): string | null {
  if (!isDict(svcDef)) return null;
  const own = svcDef["validate"];
  if (own) return String(own);
  const text = resolveServiceArchetype(svcDef, archetypes)?.["validate"];
  return text ? String(text) : null;
}

/** Selected services if any, else the services of the workspace's repos. */
export function candidateServiceNames(
  repoNames: string[],
  reposConfig: ReposConfig,
  localServices?: string[] | null,
): string[] {
  if (localServices?.length) return [...localServices];
  return repoNames.flatMap((repo) => reposConfig[repo]?.["services"] ?? []);
}

/** The roles a `stages:` map may key, in the order a stage renders them. */
export const STAGE_ROLES: readonly StageRole[] = ["research", "spec", "implement", "exercise"];

/** Longest one role's text may be: longer guidance lives in a repo doc the text links to. */
export const STAGE_TEXT_MAX = 600;

// SandboxError, not icm_external's WorkflowError: importing that module here is a cycle (via standards.ts).
function checkedStageText(owner: string, stages: unknown): StageText {
  const fail = (why: string) => {
    throw new SandboxError(`services.yaml: ${owner} ${why}`, "ICM_STAGE_TEXT");
  };
  if (stages === undefined || stages === null) return {};
  if (!isDict(stages)) fail(`stages: must be a map of ${STAGE_ROLES.join(", ")} to text`);
  for (const [role, text] of Object.entries(stages as Record<string, unknown>)) {
    if (!STAGE_ROLES.includes(role as StageRole))
      fail(`stages.${role}: unknown role (use ${STAGE_ROLES.join(", ")})`);
    if (typeof text !== "string" || !text.trim()) fail(`stages.${role} must be non-empty text`);
    // A `#`/`##` line would open a contract section of its own, and workflow export would keep it.
    if (/^#{1,2} /m.test(text as string))
      fail(`stages.${role}: headings are not allowed; use plain text`);
    const n = (text as string).trim().length;
    if (n > STAGE_TEXT_MAX)
      fail(
        `stages.${role} is ${n} characters (max ${STAGE_TEXT_MAX}): move longer guidance into a doc in its repo and link to it from here`,
      );
  }
  return stages as StageText;
}

/**
 * One service's ICM stage text per role, and the archetype it came from (`null`: the service's own).
 * Same precedence as `serviceValidation`, per role. Throws a `SandboxError` on a malformed or over-long entry.
 */
export function serviceStageText(
  svc: string,
  svcDef: ServiceEntry | null | undefined,
  archetypes?: ArchetypeRegistry | null,
): Partial<Record<StageRole, { text: string; from: string | null }>> {
  if (!isDict(svcDef)) return {};
  const own = checkedStageText(`service '${svc}'`, svcDef["stages"]);
  const archName = typeof svcDef["archetype"] === "string" ? svcDef["archetype"] : null;
  const arch = archName
    ? checkedStageText(
        `archetype '${archName}'`,
        resolveServiceArchetype(svcDef, archetypes)?.["stages"],
      )
    : {};
  const out: Partial<Record<StageRole, { text: string; from: string | null }>> = {};
  for (const role of STAGE_ROLES) {
    if (own[role]) out[role] = { text: own[role].trim(), from: null };
    else if (arch[role]) out[role] = { text: arch[role].trim(), from: archName };
  }
  return out;
}

/**
 * The `### <service>` blocks each role adds to a stage contract, `""` for none. Services with the
 * same text from the same source share one block, so an archetype on five services renders once.
 */
export function stageTextBlocks(
  services: string[],
  servicesConfig: ServicesConfig,
  archetypes?: ArchetypeRegistry | null,
): Record<StageRole, string> {
  const groups = Object.fromEntries(
    STAGE_ROLES.map((r) => [
      r,
      new Map<string, { names: string[]; text: string; from: string | null }>(),
    ]),
  ) as Record<StageRole, Map<string, { names: string[]; text: string; from: string | null }>>;
  for (const svc of [...new Set(services)].sort()) {
    for (const [role, { text, from }] of Object.entries(
      serviceStageText(svc, servicesConfig[svc], archetypes),
    ) as Array<[StageRole, { text: string; from: string | null }]>) {
      const key = `${from ?? ""}\0${text}`;
      const g = groups[role].get(key) ?? { names: [], text, from };
      g.names.push(svc);
      groups[role].set(key, g);
    }
  }
  return Object.fromEntries(
    STAGE_ROLES.map((r) => [
      r,
      [...groups[r].values()]
        .map(
          (g) =>
            `### ${g.names.map((n) => `\`${n}\``).join(", ")}${g.from ? ` (archetype \`${g.from}\`)` : ""}\n${g.text}`,
        )
        .join("\n\n"),
    ]),
  ) as Record<StageRole, string>;
}

export interface ValidationRow {
  service: string;
  repo: string;
  path: string;
  test: string | null;
  validate: string;
}

/**
 * One row per candidate service for the "How to validate" table.
 *
 * A service with a `feature_router` host and no `validate:` is reached by URL,
 * so it falls through to the health check rather than to "unregistered".
 */
export function validationRows(
  candidates: string[],
  servicesConfig: ServicesConfig,
  archetypes?: ArchetypeRegistry | null,
  routedServices: Set<string> = new Set(),
): ValidationRow[] {
  if (archetypes === undefined || archetypes === null) archetypes = loadArchetypes();
  const rows: ValidationRow[] = [];
  for (const svc of [...new Set(candidates)].sort()) {
    const svcDef = servicesConfig[svc];
    if (!isDict(svcDef)) continue;
    const own = serviceValidation(svcDef, archetypes);
    rows.push({
      service: svc,
      repo: String(svcDef["repo"] ?? ""),
      path: String(svcDef["path"] ?? "."),
      test: serviceTestCommand(svc, svcDef, archetypes),
      validate:
        own ??
        (routedServices.has(svc)
          ? "URL health check (see Quick Health Checks)"
          : "No validation guidance registered in services.yaml; say so instead of inventing one"),
    });
  }
  return rows;
}

/**
 * Map each *named* archetype present in a workspace to its services.
 *
 * Presence follows the same candidate-service rule as
 * `resolveActiveStandards` in standards.ts: the workspace's selected
 * services win over the repo-derived set (a monorepo spans several
 * archetypes; selection is the declared intent), repos are the fallback.
 * Anonymous legacy archetypes (bare `standards:`) have no name to key a
 * generated agent on and are excluded — they only ever contributed
 * standards.
 */
export function resolvePresentArchetypes(
  repoNames: string[],
  servicesConfig: ServicesConfig,
  reposConfig: ReposConfig,
  localServices?: string[] | null,
  archetypes?: ArchetypeRegistry | null,
): Record<string, string[]> {
  if (archetypes === undefined || archetypes === null) archetypes = loadArchetypes();

  const candidateServices = candidateServiceNames(repoNames, reposConfig, localServices);

  const present: Record<string, string[]> = {};
  for (const svc of candidateServices) {
    const svcDef = servicesConfig[svc];
    if (!isDict(svcDef)) continue;
    const name = svcDef["archetype"];
    if (name && name in archetypes) {
      (present[name] ??= []).push(svc);
    }
  }
  const result: Record<string, string[]> = {};
  for (const name of Object.keys(present).sort()) {
    result[name] = [...new Set(present[name])].sort();
  }
  return result;
}

/**
 * The archetypes present in a workspace, resolved from its repos and meta.
 *
 * Takes the already-loaded config rather than reading it itself — `jit.init`
 * and `initWorkspace`'s post-strategy 6d step each load services.yaml/repos
 * config and the archetype registry once (for their own other needs) and
 * pass those same values in, so the resolve-present block exists once
 * without either caller's config load happening twice
 * (docs/context-strategies.md).
 */
export function presentArchetypes(
  repos: Array<[string, string]>,
  meta: Record<string, string>,
  servicesConfig: ServicesConfig,
  reposConfig: ReposConfig,
  archetypes: ArchetypeRegistry,
): Record<string, string[]> {
  const localServices = (meta["SERVICES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);
  return resolvePresentArchetypes(
    repos.map(([name]) => name),
    servicesConfig,
    reposConfig,
    localServices,
    archetypes,
  );
}

/**
 * Return error strings for archetype drift in services.yaml.
 *
 * An unknown reference means the registry and a service entry have
 * diverged; both-forms means the entry is ambiguous — surface each clearly
 * at workspace time rather than silently resolving.
 */
export function validateServiceArchetypes(
  servicesConfig: ServicesConfig,
  archetypes: ArchetypeRegistry,
): string[] {
  const errors: string[] = [];
  for (const [svc, svcDef] of Object.entries(servicesConfig)) {
    if (!isDict(svcDef)) continue;
    const name = svcDef["archetype"];
    if (name === undefined || name === null) continue;
    if (!(name in archetypes)) {
      errors.push(
        `services.yaml: service '${svc}' references unknown archetype ` +
          `'${name}' — no \`archetypes.${name}\` entry`,
      );
    }
    if (svcDef["standards"]?.length) {
      errors.push(
        `services.yaml: service '${svc}' declares both \`archetype:\` and ` +
          "legacy `standards:` — drop `standards:` (the archetype wins)",
      );
    }
  }
  return errors;
}

/**
 * SW-845: *registry* with each entry's `extra_volumes` widened to every bind compose mounts: the
 * branch's own fragment and the workspace's `dev_links` too (both agent-editable), variables
 * substituted as generate.ts does. Only the mounts: test commands stay the registry's.
 * *branch* is registry_sync.ts's `workspaceServices(registry, workspaceRoot)`; importing it here is a cycle.
 */
export function withComposeMounts(
  registry: ServicesConfig,
  workspaceRoot: string,
  branch: ServicesConfig,
): ServicesConfig {
  // generate.ts's loadDevLinks reads the same field, but generate imports this module.
  let devLinks: Record<string, string[]> = {};
  try {
    const yml = parseYaml(
      fs.readFileSync(path.join(dotDir(workspaceRoot), "workspace.yml"), "utf8"),
    );
    devLinks = yml?.["dev_links"] ?? {};
  } catch {
    // No workspace.yml (or unreadable): no dev_links, as generate.ts reads it.
  }
  return Object.fromEntries(
    Object.entries(registry).map(([id, entry]) => {
      const repo = path.join(workspaceRoot, String(branch[id]?.["repo"] ?? entry["repo"] ?? ""));
      const specs = [
        ...(entry.extra_volumes ?? []),
        ...(branch[id]?.extra_volumes ?? []),
        ...(devLinks[id] ?? []),
      ].map((s) => {
        const out = s.split("${WORKSPACE}").join(workspaceRoot).split("${REPO}").join(repo);
        return out.includes("${WERKMEISTER_ROOT}")
          ? out.split("${WERKMEISTER_ROOT}").join(sandboxRoot())
          : out;
      });
      return [id, { ...entry, extra_volumes: specs }];
    }),
  );
}
