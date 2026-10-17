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

import {
  type Archetype,
  type ArchetypeRegistry,
  loadArchetypes,
  type ReposConfig,
  type ServiceEntry,
  type ServicesConfig,
} from "./config.js";

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
  if (!isDict(svcDef)) return null;
  const own = svcDef["test"];
  if (own) return String(own);
  const arch = resolveServiceArchetype(svcDef, archetypes);
  const template = arch?.["test"];
  if (!template) return null;
  return String(template).split("{service}").join(svcName);
}

/**
 * How the agent runs *cmd* from the host: in the service's container, where the
 * worktree's `node_modules` live. sandbox-context.md and the workspace's
 * `permissions.allow` rule both use it, so the rule matches what the agent runs.
 */
export function containerTestCommand(feature: string, svc: string, cmd: string): string {
  return `docker exec ${feature}-${svc} sh -c '${cmd}'`;
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
