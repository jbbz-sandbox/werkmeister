/**
 * CLAUDE.md / routing-table / sandbox-context builders — extracted from
 * init-workspace per DEBT-03 (it was the largest file in the codebase,
 * mixing workspace discovery,
 * input resolution, interactive prompting, CLAUDE.md generation, and compose
 * orchestration).
 *
 * This module owns pure string-rendering logic for the workspace-facing
 * markdown artifacts: the workspace `CLAUDE.md`, its routing table, and
 * `.sandbox/sandbox-context.md`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { ingressHostnames, loadFeatureRouters } from "./feature_routing.js";
import { loadIngress } from "./global_config.js";
import { standardsSource, standardsUrl } from "./skill_gen.js";
import { getServicePort } from "./slots.js";
import { universalStandards } from "./standards.js";

/**
 * The public hostname to point the reader at, and the cookie's domain scope.
 *
 * Derived from the ingress config + `feature_router:` blocks rather than
 * hardcoded: the routed host set is per-machine, so a literal would send every
 * workspace to a host that may not exist. Prefers a service this feature
 * actually runs, else any routed service. Returns null when nothing is routed
 * (or the config can't be read) so callers omit the URL instead of inventing one.
 */
export function resolveProxyHost(serviceNames: string[]): { host: string; domain: string } | null {
  try {
    const ingress = loadIngress();
    const routers = loadFeatureRouters(undefined, ingress);
    const preferred = serviceNames.find((name) => routers[name]?.hostname);
    const host = preferred
      ? routers[preferred].hostname
      : Object.values(routers)
          .map((r) => r.hostname)
          .filter(Boolean)
          .sort()[0];
    if (!host) return null;
    return { host, domain: ingress.local_domain.replace(/^\.+/, "") };
  } catch {
    return null;
  }
}

function isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// CLAUDE.md generation
// ---------------------------------------------------------------------------

/**
 * Build the routing table for CLAUDE.md.
 *
 * Per-repo routing rows are only emitted when `{repo}/CLAUDE.md` actually
 * exists — pointing at a file that isn't there is worse than no row at all.
 * Everything about the running feature (URL, cookie, ports, lifecycle, health
 * checks) is one row: it all lives in sandbox-context.md.
 */
export function buildRoutingTable(
  repos: Array<[string, string]>,
  workspaceRoot: string,
  hasFeature: boolean,
): string {
  const rows: string[] = [];

  for (const [name] of repos) {
    let isFile = false;
    try {
      isFile = fs.statSync(path.join(workspaceRoot, name, "CLAUDE.md")).isFile();
    } catch {
      /* missing — no row */
    }
    if (isFile) {
      rows.push(`| Working in ${name} | ${name}/CLAUDE.md |`);
    }
  }

  if (hasFeature) {
    rows.push(
      "| Running the feature — URL, X-Feature cookie, ports, lifecycle, health checks | .sandbox/sandbox-context.md |",
    );
  }

  if (repos.length > 1) {
    rows.push("| Cross-repo contract change | .sandbox/notes/ (`contract` notes) |");
  }

  if (rows.length === 0) {
    return "";
  }

  return "| Task | Read |\n|------|------|\n" + rows.join("\n");
}

/**
 * Render the "Standards routing" block (jit-context-system.md §5.3).
 *
 * The compiled, inspectable projection of services.yaml `standards:` +
 * workspace.yml `standards_override` — the ICM Layer-1 table. The
 * `sb-<key>-standard` skills it references are generated from
 * docs/standards/ and projected into the workspace's `.claude/skills/` by
 * init-workspace (`workspace_skills.ts`); `sb-implement`/`sb-research`/
 * `sb-test`/`sb-review` are the phase-entry skills that read this table (docs/jit-context-system.md §5.2 — the
 * CLAUDE.md-table → entry-skill chain is the measured 15/15 PREVENTIVE
 * mechanism).
 */
export function buildStandardsRoutingSection(
  active: string[],
  modules: Record<string, Record<string, any>>,
  repoNames: string[],
): string {
  const universal = universalStandards(modules);
  const rows: string[] = [];
  for (const key of active) {
    const meta = modules[key] ?? {};
    let loadsOn: string;
    if (universal.includes(key)) {
      loadsOn = "any code edit";
    } else {
      loadsOn =
        ((meta["applies_to"] || []) as string[]).map((g) => `\`${g}\``).join(", ") || "—";
    }
    rows.push(`| ${key} | \`sb-${key}-standard\` | ${loadsOn} |`);
  }

  const reposLabel = repoNames.length > 0 ? repoNames.join(", ") : "none discovered";

  // Points at the standards tree itself, wherever `overrides.standards_dir`
  // resolves to — the old link named this repo's code-style-guide.md, a thin
  // index that only routes onward to that tree. Omitted when underivable
  // rather than guessed (see skill_gen.standardsSource).
  const treeUrl = standardsUrl(standardsSource(), "", "tree");
  const sourceLine = treeUrl ? `\n> Module source: ${treeUrl}` : "";

  // Named from the tree's own universal set rather than spelled out: an org
  // whose base is not comments+engineering would otherwise read a phase-entry
  // instruction listing skills its workspace does not have. `ponytail` is a
  // plugin, not a standard, so it stays literal.
  const universalSkills = ["`ponytail`", ...universal.map((k) => `\`sb-${k}-standard\``)].join(
    " + ",
  );

  return `## Standards routing

> Compiled from services.yaml + .sandbox/workspace.yml (\`standards_override\`) — regenerated by \`sandbox init-workspace\`. Do not hand-edit.${sourceLine}

**Active in this workspace** (repos: ${reposLabel}):

| Standard | Skill | Loads on |
|----------|-------|----------|
${rows.join("\n")}

**By phase** — invoke the entry skill before starting the phase:

| Phase | Invoke first | Loads |
|-------|--------------|-------|
| research / planning | \`sb-research\` | nothing — spawns the read-only \`sb-researcher\` agent |
| implementing (before the first code edit) | \`sb-implement\` | universal base (${universalSkills}) + rows matching the files you edit |
| testing | \`sb-test\` | nothing — spawns the matching \`sb-tester-<archetype>\` agent(s) |
| review (before reading any diff or PR) | \`sb-review\` | the standards covering files in the diff |
| PR / finishing | \`sb-pr\` | nothing — runs the pre-PR gate, then \`sb-review\` |

`;
}

/** Render the workspace CLAUDE.md content. */
export function buildClaudeMd(
  workspaceName: string,
  workspaceRoot: string,
  repos: Array<[string, string]>,
  task: string,
  meta: Record<string, string>,
  standardsSection: string | null = null,
): string {
  const layoutLines = repos.map(([name, branch]) => `- ${name}/ — branch: ${branch}`).join("\n");

  const hasFeature = Boolean((meta["FEATURE"] ?? "").trim());
  const routingTable = buildRoutingTable(repos, workspaceRoot, hasFeature);
  const routingSection = routingTable
    ? `\n## Routing\n\n${routingTable}\n\n## Context Budget\n\n` +
      "Load only what the routing table points to for your current task. " +
      "Target: ≤ 3 context files per step unless a repo's CLAUDE.md explicitly requires more.\n"
    : "";

  const repoCount = repos.length;
  const layoutHeader =
    repoCount > 1
      ? "This is a multi-repo workspace. Repositories:"
      : "This is a single-repo workspace. Repository:";

  // Notes — a generated pointer to the durable .sandbox/notes/ store
  // (jit-context-system.md §5.3: this file is a compiled projection
  // and holds no handoff state, so regen loses nothing). Multi-repo
  // workspaces get the cross-repo contract-note rule folded into the
  // pointer text; single-repo workspaces don't need the coordination rubric.
  const contractRule =
    repoCount > 1
      ? "\nRecord contract changes (API schema, shared types, event contracts) as " +
        "`contract` notes **before** switching repos; read them when entering the " +
        "receiving repo.\n"
      : "";
  const notesSection = `## Notes

Working notes live in [.sandbox/notes/](.sandbox/notes/) — \`NNN-<type>-<slug>.md\`. Types and rules: docs/notes-conventions.md in the sandbox repo.

Read relevant notes first; skip \`status: superseded\`. \`decision\` notes are binding and override task-level instincts — on conflict, raise it to the user rather than picking a side.
${contractRule}`;

  // Current Task — Jira inlined when available. The task description, when
  // provided, fills the "what + why" body; otherwise an HTML comment prompts
  // the developer to write a 1-2 sentence "what + why" rather than leaving the
  // workspace context with only the task title.
  const jiraId = (meta["JIRA_ID"] ?? "").trim();
  const currentTaskLine = jiraId
    ? `${task} — [${jiraId}](https://hgdata.atlassian.net/browse/${jiraId})`
    : task;
  const description = (meta["DESCRIPTION"] ?? "").trim();
  const taskBody = description
    ? description
    : "<!-- Replace this comment with 1-2 sentences describing what this " +
      "feature does and the user-visible outcome. -->";
  const currentTaskSection = `## Current Task\n\n${currentTaskLine}\n\n${taskBody}\n`;

  // Code Standards — the compiled "Standards routing" block when the caller
  // resolved one (repo-scoped JIT loading, docs/jit-context-system.md §5.3);
  // otherwise point at the standards tree itself. No tree URL means no
  // checkout to name, so the fallback states the rule and stops.
  let codeStandardsSection: string;
  if (standardsSection !== null) {
    codeStandardsSection = standardsSection;
  } else {
    const treeUrl = standardsUrl(standardsSource(), "", "tree");
    codeStandardsSection =
      "## Code Standards\n\n" +
      "Follow the canonical cross-repo code standards (comment rubric, per-repo " +
      "quirks)" +
      (treeUrl ? `: ${treeUrl}` : ".") +
      "\n\n";
  }

  return `# Workspace: ${workspaceName}

${currentTaskSection}
## Layout

${layoutHeader}

${layoutLines}
${routingSection}
${codeStandardsSection}${notesSection}`;
}

// ---------------------------------------------------------------------------
// sandbox-context.md generation
// ---------------------------------------------------------------------------

/** Render .sandbox/sandbox-context.md — ports, service topology, lifecycle commands, health checks. */
export function buildSandboxContextMd(
  feature: string,
  slot: number,
  portStart: number,
  portEnd: number,
  localServices: string[],
  servicesConfig: Record<string, any>,
  testPath = "",
): string {
  // Routed hosts come from the ingress config + `feature_router:` blocks — the
  // same source Caddy's site blocks are generated from — so this file can never
  // name a host the proxy doesn't actually terminate.
  let routedHosts: string[] = [];
  try {
    routedHosts = ingressHostnames(servicesConfig);
  } catch {
    routedHosts = [];
  }
  const routingHostList = routedHosts.length
    ? `These hosts are routed through Caddy:\n\n` +
      routedHosts.map((host) => `- \`https://${host}\``).join("\n")
    : "No services declare a `feature_router:` block, so Caddy terminates no public hosts for this workspace.";

  // Health checks are per workspace: only the hosts of services this feature
  // runs locally. The routed-host list below stays machine-wide — it describes
  // what Caddy terminates, which is a fact about the proxy, not the feature.
  let localHosts: string[] = [];
  try {
    const routers = loadFeatureRouters(servicesConfig);
    localHosts = localServices
      .map((svc) => routers[svc]?.hostname)
      .filter((h): h is string => Boolean(h))
      .sort();
  } catch {
    localHosts = [];
  }

  const k8sPort = (svc: string): number | null => {
    // k8s-forwards container listen-port; single source is services.yaml.
    const svcDef = servicesConfig[svc] ?? {};
    if (isDict(svcDef) && svcDef["k8s_forward_port"] !== null && svcDef["k8s_forward_port"] !== undefined) {
      return Number(svcDef["k8s_forward_port"]);
    }
    return null;
  };

  // Unified service table — one row per service, sorted local-first then alpha.
  // Replaces the previous three-way split (Local Services / k8s Port-Forwarded /
  // Service Discovery URLs) which described the same services three different ways.
  const serviceRows: string[] = [];
  let firstLocalHostPort: number | null = null;
  for (const svc of [...localServices].sort()) {
    const svcDef = servicesConfig[svc] ?? {};
    if (!isDict(svcDef)) {
      continue;
    }
    const offset = svcDef["port_offset"] ?? 0;
    const hostPort = getServicePort(slot, offset);
    if (firstLocalHostPort === null) {
      firstLocalHostPort = hostPort;
    }
    const internalPort = svcDef["internal_port"] ?? 3000;
    const envVar = `${svc.toUpperCase().replace(/-/g, "_")}_URL`;
    serviceRows.push(
      `| \`${svc}\` | local | \`${svcDef["path"] ?? "."}\` | \`${feature}-${svc}\` | ${hostPort} | \`${envVar}=http://${svc}:${internalPort}\` |`,
    );
  }
  for (const svc of Object.keys(servicesConfig).sort()) {
    if (localServices.includes(svc)) {
      continue;
    }
    const svcDef = servicesConfig[svc] ?? {};
    if (!isDict(svcDef)) {
      continue;
    }
    const port = k8sPort(svc);
    if (!port) {
      continue;
    }
    const envVar = `${svc.toUpperCase().replace(/-/g, "_")}_URL`;
    serviceRows.push(
      `| \`${svc}\` | k8s | \`${svcDef["path"] ?? "."}\` | — | — | \`${envVar}=http://k8s-forwards:${port}\` |`,
    );
  }

  let servicesTable: string;
  if (serviceRows.length > 0) {
    servicesTable =
      "| Service | Location | Path in repo | Container | Host Port | In-cluster URL (env var) |\n" +
      "|---------|----------|--------------|-----------|-----------|--------------------------|\n" +
      serviceRows.join("\n");
  } else {
    servicesTable = "_No services configured._";
  }

  // Container commands — show the naming pattern once instead of repeating
  // `docker logs {feature}-{svc} -f` for every service.
  let containerCommandsBlock: string;
  if (localServices.length > 0) {
    const svcs = [...localServices].sort();
    const containerList = svcs.map((s) => `\`${feature}-${s}\``).join(", ");
    const sampleSvc = svcs[0];
    containerCommandsBlock = `### Container Commands

Container naming pattern: \`${feature}-<service>\` — ${containerList}

\`\`\`bash
docker logs <container> -f         # follow logs
docker logs <container> --tail 50  # last 50 lines
docker exec -it <container> sh     # shell in

# Or via compose (run from workspace root):
docker compose ps
docker compose logs -f ${sampleSvc}
docker compose restart ${sampleSvc}
\`\`\`

`;
  } else {
    containerCommandsBlock = "";
  }

  // Quick health checks — direct-to-localhost line must hit a real local
  // service port, not `port_start` (the slot base) where nothing listens.
  let healthChecks: string;
  if (localServices.length > 0 && firstLocalHostPort !== null) {
    const directCheck =
      "# Direct to a local service (bypass Caddy — isolates routing vs app issues):\n" +
      'curl -s -o /dev/null -w "HTTP %{http_code} | Size: %{size_download}\\n" ' +
      `"http://localhost:${firstLocalHostPort}/"\n\n`;
    const proxyCheck = localHosts.length
      ? "# Through Caddy (verifies full proxy routing):\n" +
        localHosts
          .map(
            (host) =>
              `curl -sk -b "X-Feature=${feature}" -o /dev/null -w "HTTP %{http_code} | Size: %{size_download}\\n" ` +
              `"https://${host}/"\n`,
          )
          .join("") +
        "\n"
      : "";
    const statusCheck =
      "# Container status:\n" +
      `docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}" | grep ${feature}`;
    healthChecks = proxyCheck + directCheck + statusCheck;
  } else {
    healthChecks =
      "# Through Caddy (all traffic routes to k8s):\n" +
      routedHosts
        .map(
          (host) =>
            'curl -sk -o /dev/null -w "HTTP %{http_code} | Size: %{size_download}\\n" ' +
            `"https://${host}/"\n`,
        )
        .join("")
        .trimEnd();
  }

  // The feature URL + routing cookie snippet CLAUDE.md used to carry — scoped
  // to a host this feature actually runs, so it's never a link to nowhere.
  const proxy = resolveProxyHost(localServices);
  const featureBlock = proxy
    ? `
**Feature URL:** https://${proxy.host}/${testPath.replace(/^\/+/, "")}

Set the routing cookie in the browser (DevTools console):

\`\`\`js
document.cookie = "X-Feature=${feature}; domain=.${proxy.domain}; path=/; SameSite=Lax";
\`\`\`

or visit https://${proxy.host}/__sandbox and select \`${feature}\` — the selector is served on every routed host and the cookie applies to each host sharing the base domain.
`
    : "";

  return `<!--
  AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
  Source:    ~/.sandbox/services.yaml + ports.yaml
             + .sandbox/workspace.yml (feature, services, slot)
  Generator: packages/sandbox-core/claude_md.ts :: buildSandboxContextMd
  Regen:     sandbox init-workspace  (or \`sandbox up\` after slot changes)
  To change ports/health endpoints/services, edit services.yaml / ports.yaml.
  To change which services run locally, edit .sandbox/workspace.yml and rerun.
-->

# Sandbox Context: ${feature}

## Slot & Port Range

- **Slot:** ${slot}
- **Port range:** ${portStart}–${portEnd}

## Container Lifecycle

Run from anywhere in the workspace — \`sandbox\` reads \`FEATURE\` from \`.env\` at the workspace root.

\`\`\`bash
sandbox up          # start containers + configure Caddy proxy
sandbox stop        # stop (slot preserved, fast resume)
sandbox restart     # restart all containers
sandbox down        # tear down + release slot
sandbox down -v     # tear down + remove volumes (node_modules, caches)
\`\`\`

> **Fallback:** If \`sandbox\` CLI is unavailable, \`docker compose up -d --build\` / \`docker compose down\` from the workspace root works equivalently. Prefer \`sandbox\` — it also manages slot allocation and Caddy proxy regeneration.

## Services

Every container gets each service's URL injected as an env var (the last column). Local services resolve to the Docker DNS alias on the per-feature network; k8s-forwarded services resolve via the shared \`k8s-forwards\` container.

${servicesTable}

${containerCommandsBlock}## Quick Health Checks

\`\`\`bash
${healthChecks}
\`\`\`

## Proxy Routing

${routingHostList}

Set \`X-Feature=${feature}\` (cookie or header) to route to this workspace's local containers; otherwise traffic falls through to the k8s port-forwards.

${featureBlock}
## Troubleshooting

### Feature missing from \`/__sandbox\` selector

The dropdown is populated from \`$SANDBOX_ROOT/infra/proxy/ui/features.json\` (a static file served by Caddy), which is regenerated alongside the Caddyfile. It can drift from the live container labels (\`com.sandbox.local.feature\` — the source of truth) if a slot is allocated without a proxy regen.

Diagnose — compare what's labeled vs. what the UI shows:
\`\`\`bash
docker ps -a --filter label=com.sandbox.local.feature   --format '{{ .Label "com.sandbox.local.feature" }}' | sort -u
jq '[.[].name]' "\${SANDBOX_ROOT:-$HOME/workspace/sandbox}/infra/proxy/ui/features.json"
\`\`\`

Resync:
\`\`\`bash
sandbox proxy-reload      # regenerates Caddyfile + features.json, reloads Caddy
\`\`\`

### Caddy returns \`content-length: 0\` but direct service hit works

Caddy routing issue, not an app issue. Try \`sandbox proxy-reload\` first; if Caddy is still misrouting, check \`docker logs sandbox-caddy --tail 50\`.

### Containers expected per the table above are missing from \`docker ps\`

\`sandbox up\` may have partially failed. Re-run from the workspace root:
\`\`\`bash
sandbox up                # idempotent — starts missing containers
docker compose logs -f    # watch startup if something crashes
\`\`\`
`;
}
