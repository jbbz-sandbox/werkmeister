/**
 * Service archetype resolution — build-plan step 1 of
 * docs/jit-agents-and-tools-spec.md (§4.1).
 *
 * An archetype is a named bundle in services.yaml's `archetypes:` registry
 * describing what a service *type* contributes to workspace generation:
 * standards modules today; MCP servers, test commands, and per-archetype
 * subagents in later build steps. A service opts in with `archetype: <name>`.
 *
 * Migration (spec §4.1, decided 2026-07-04): the shipped per-service
 * `standards: [key]` form stays valid — it normalizes here into an anonymous
 * archetype `{standards: [...]}` — so both forms coexist with no flag day.
 * Everything downstream reads through `resolveServiceArchetype` and never
 * touches the raw fields.
 */

import { loadArchetypes } from "./config.js";

function isDict(value: unknown): value is Record<string, any> {
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
  svcDef: any,
  archetypes?: Record<string, any> | null,
): Record<string, any> | null {
  if (!isDict(svcDef)) return null;
  const name = svcDef["archetype"];
  if (name !== undefined && name !== null) {
    if (archetypes === undefined || archetypes === null) archetypes = loadArchetypes();
    const arch = archetypes[name];
    return isDict(arch) ? arch : null;
  }
  const legacy = svcDef["standards"];
  if (legacy && (legacy as any).length) {
    return { standards: Array.from(legacy) };
  }
  return null;
}

/** The standards keys a service contributes, via its archetype. */
export function serviceStandards(
  svcDef: any,
  archetypes?: Record<string, any> | null,
): string[] {
  const arch = resolveServiceArchetype(svcDef, archetypes);
  return Array.from((arch ?? {})["standards"] ?? []);
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
  svcDef: any,
  archetypes?: Record<string, any> | null,
): string | null {
  if (!isDict(svcDef)) return null;
  const own = svcDef["test"];
  if (own) return String(own);
  const arch = resolveServiceArchetype(svcDef, archetypes);
  const template = (arch ?? {})["test"];
  if (!template) return null;
  return String(template).split("{service}").join(svcName);
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
  servicesConfig: Record<string, any>,
  reposConfig: Record<string, any>,
  localServices?: string[] | null,
  archetypes?: Record<string, any> | null,
): Record<string, string[]> {
  if (archetypes === undefined || archetypes === null) archetypes = loadArchetypes();

  let candidateServices: string[];
  if (localServices && localServices.length) {
    candidateServices = [...localServices];
  } else {
    candidateServices = repoNames.flatMap(
      (repo) => (reposConfig[repo] ?? {})["services"] ?? [],
    );
  }

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
 * Return error strings for archetype drift in services.yaml.
 *
 * An unknown reference means the registry and a service entry have
 * diverged; both-forms means the entry is ambiguous — surface each clearly
 * at workspace time rather than silently resolving.
 */
export function validateServiceArchetypes(
  servicesConfig: Record<string, any>,
  archetypes: Record<string, any>,
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
    if (svcDef["standards"] && (svcDef["standards"] as any).length) {
      errors.push(
        `services.yaml: service '${svc}' declares both \`archetype:\` and ` +
          "legacy `standards:` — drop `standards:` (the archetype wins)",
      );
    }
  }
  return errors;
}
