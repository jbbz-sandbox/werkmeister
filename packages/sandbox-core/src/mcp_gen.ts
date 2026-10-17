/**
 * Generated workspace MCP enablement — build-plan step 5 of
 * docs/jit-context-system.md (§5.5).
 *
 * Projects the union of the workspace's present archetypes' `mcp_servers:`
 * into the workspace's `.mcp.json`. Union rule (§5.5): connection is
 * cheap — schemas defer until ToolSearch — so over-granting across archetypes
 * is fine; the win is *not connecting* servers no archetype wants.
 *
 * Like settings.json (hooks_gen), `.mcp.json` may legitimately hold user-added
 * servers, and JSON carries no do-not-hand-edit comment — so this generator
 * merges. Its managed namespace is the names in the services.yaml
 * `mcp_servers:` registry: those it adds, updates, and prunes; everything else
 * is preserved untouched.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Union the present archetypes' `mcp_servers:` names, sorted. */
export function resolveWorkspaceMcpServers(
  presentArchetypes: Record<string, string[]>,
  archetypes: Record<string, any>,
): string[] {
  const names = new Set<string>();
  for (const archName of Object.keys(presentArchetypes)) {
    const arch = archetypes[archName] ?? {};
    for (const s of arch["mcp_servers"] ?? []) names.add(s);
  }
  return [...names].sort();
}

/**
 * Return error strings for `mcp_servers:` names with no definition.
 *
 * An unknown name means the archetype registry and the `mcp_servers:`
 * definition block have drifted — surface it at workspace time rather than
 * silently projecting nothing.
 */
export function validateArchetypeMcpServers(
  archetypes: Record<string, any>,
  definitions: Record<string, any>,
): string[] {
  const errors: string[] = [];
  for (const name of Object.keys(archetypes).sort()) {
    const arch = archetypes[name];
    if (typeof arch !== "object" || arch === null || Array.isArray(arch)) {
      continue;
    }
    for (const server of arch["mcp_servers"] ?? []) {
      if (!(server in definitions)) {
        errors.push(
          `services.yaml: archetype '${name}' lists MCP server ` +
            `'${server}' — no \`mcp_servers.${server}\` definition`,
        );
      }
    }
  }
  return errors;
}

/**
 * Replace `${NAME}` in every string of *value* for each name in *vars*.
 *
 * A dumb recursive string substitution over the definition body rather than a
 * field the registry schema knows about: the registry stays free-form JSON, and
 * any future server that wants the feature gets it the same way. An unmatched
 * `${...}` — `${SANDBOX_MCP_TOKEN}`, expanded by the MCP client from the
 * container's environment — is written through untouched, which is what keeps
 * the token out of a file that lives inside a git worktree.
 *
 * Returns new values throughout: the caller's `definitions` is the shared
 * registry, reused for every workspace in the same process.
 */
function substituteVars(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(vars, name) ? vars[name] : match,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVars(item, vars));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substituteVars(v, vars),
      ]),
    );
  }
  return value;
}

/**
 * Merge the wanted server definitions into `.mcp.json`.
 *
 * Managed namespace = the definition registry's keys: wanted ones are written
 * (refreshing stale bodies), registry-known-but-unwanted ones are pruned (a
 * previous service selection projected them), and user-added servers under
 * other names are preserved. Unparseable existing JSON is left untouched — a
 * human put something there. Returns `null` when there is nothing to write and
 * no file exists (don't litter workspaces with empty projections).
 */
export function writeWorkspaceMcp(
  workspaceRoot: string,
  serverNames: string[],
  definitions: Record<string, any>,
  vars: Record<string, string> = {},
): string | null {
  const mcpPath = path.join(workspaceRoot, ".mcp.json");
  const isFile = fs.existsSync(mcpPath) && fs.statSync(mcpPath).isFile();
  let config: Record<string, any> = {};
  if (isFile) {
    try {
      const existing = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        config = existing;
      } else {
        return mcpPath;
      }
    } catch {
      return mcpPath;
    }
  }

  const wanted: Record<string, any> = {};
  for (const name of serverNames) {
    if (name in definitions) wanted[name] = substituteVars(definitions[name], vars);
  }
  if (Object.keys(wanted).length === 0 && !isFile) {
    return null;
  }

  if (!("mcpServers" in config)) {
    config["mcpServers"] = {};
  }
  const servers = config["mcpServers"];
  for (const name of Object.keys(servers)) {
    if (name in definitions && !(name in wanted)) {
      delete servers[name];
    }
  }
  Object.assign(servers, wanted);

  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
  return mcpPath;
}
