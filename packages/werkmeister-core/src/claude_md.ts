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
import { containerTestCommand, serviceTestCommand, validationRows } from "./archetypes.js";
import { type ArchetypeRegistry, loadArchetypes, type ServicesConfig } from "./config.js";
import { ingressHostnames, loadFeatureRouters } from "./feature_routing.js";
import { loadIngress } from "./global_config.js";
import { issueLink } from "./issue_tracker.js";
import { standardsSource, standardsUrl } from "./skill_gen.js";
import { getServicePort } from "./slots.js";
import { universalStandards } from "./standards.js";
import { renderIssueRef } from "./strategies/issue_section.js";
import type { IssueRef } from "./strategies/types.js";
import { DEFAULT_PLAN, type Phase, planFor, type WorkTypePlan } from "./workspace_prompts.js";

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
      "| Running or validating the change — test commands, how to validate, ports, lifecycle | .sandbox/sandbox-context.md |",
    );
  }

  if (repos.length > 1) {
    rows.push("| Cross-repo contract change | .sandbox/notes/ (`contract` notes) |");
  }

  rows.push(
    "| Open or create a PR (including `/create-pr`), merge, close out | .sandbox/pr-rules.md |",
  );

  if (rows.length === 0) {
    return "";
  }

  return "| Task | Read |\n|------|------|\n" + rows.join("\n");
}

/** The Gate line for a plan — what must exist before the first source edit. */
function gateLine(plan: WorkTypePlan): string {
  if (plan.path === "spike") {
    return "No implement, review, or PR phase. Deliverable: `finding` notes. Anything built is throwaway.";
  }
  if (plan.gate === null) {
    return "Gate: none — `sb-implement` loads the standards.";
  }
  if (plan.gate.status) {
    return (
      `Gate: no source edit until a \`${plan.gate.note}\` note in \`.sandbox/notes/\` reads ` +
      `\`status: ${plan.gate.status}\`. Write it at the end of research, after the user approves ` +
      "the design; the flip *is* the approval — do not ask again."
    );
  }
  return `Gate: no source edit until a \`${plan.gate.note}\` note in \`.sandbox/notes/\` names the root cause.`;
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
 * mechanism). *workType* selects which By-phase rows render and adds the Work type / Gate lines; an empty or unknown type renders all five rows and no gate (`DEFAULT_PLAN`).
 */
export function buildStandardsRoutingSection(
  active: string[],
  modules: Record<string, Record<string, any>>,
  repoNames: string[],
  workType: string = "",
): string {
  const universal = universalStandards(modules);
  const rows: string[] = [];
  for (const key of active) {
    const meta = modules[key] ?? {};
    let loadsOn: string;
    if (universal.includes(key)) {
      loadsOn = "any code edit";
    } else {
      loadsOn = ((meta["applies_to"] || []) as string[]).map((g) => `\`${g}\``).join(", ") || "—";
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

  const plan = planFor(workType);
  const phaseRows: Record<Phase, string> = {
    research:
      "| research / planning | `sb-research` | nothing — spawns the read-only `sb-researcher` agent |",
    implement: `| implementing (before the first code edit) | \`sb-implement\` | universal base (${universalSkills}) + rows matching the files you edit |`,
    test: "| testing | `sb-test` | nothing — spawns the matching `sb-tester-<archetype>` agent(s) |",
    review:
      "| review (before reading any diff or PR) | `sb-review` | the standards covering files in the diff |",
    pr: "| PR / finishing | `sb-pr` | `.sandbox/pr-rules.md` — PRs open only via `sandbox pr open` |",
  };
  const workTypeBlock =
    plan === DEFAULT_PLAN
      ? ""
      : `**Work type:** ${workType.trim().toLowerCase()} (${plan.path} path) — phases: ` +
        `${plan.phases.join(" → ")}.\n${gateLine(plan)}\n\n`;

  return `## Standards routing

> Compiled from services.yaml + .sandbox/workspace.yml (\`standards_override\`) — regenerated by \`sandbox init-workspace\`. Do not hand-edit.${sourceLine}

**Active in this workspace** (repos: ${reposLabel}):

| Standard | Skill | Loads on |
|----------|-------|----------|
${rows.join("\n")}

${workTypeBlock}**By phase** — invoke the entry skill before starting the phase:

| Phase | Invoke first | Loads |
|-------|--------------|-------|
${plan.phases.map((p) => phaseRows[p]).join("\n")}

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
  issue: IssueRef | null = null,
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

  // Current Task — the workspace's issue inlined when available. The
  // task description, when provided, fills the "what + why" body; otherwise an
  // HTML comment prompts the developer to write a 1-2 sentence "what + why"
  // rather than leaving the workspace context with only the task title.
  const link = issue ? null : issueLink(meta);
  const currentTaskLine = !link
    ? task
    : link[1]
      ? `${task} — [${link[0]}](${link[1]})`
      : `${task} — ${link[0]}`;
  const description = (meta["DESCRIPTION"] ?? "").trim();
  const taskBody = description
    ? description
    : "<!-- Replace this comment with 1-2 sentences describing what this " +
      "feature does and the user-visible outcome. -->";
  const currentTaskSection = `## Current Task\n\n${currentTaskLine}\n\n${taskBody}\n${issue ? `\n${renderIssueRef(issue)}` : ""}`;

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
${codeStandardsSection}${notesSection}
## Issues

Hit a bug, or need to log a feature or task, in the \`sandbox\` tool or a repo's code? If this workspace's changes caused a bug, fix it here; otherwise file an issue (bug | feature | task) where it belongs (the sandbox repo, or this machine's issue tracker) and report the URL. Rules, labels and templates: [.sandbox/issues-report.md](.sandbox/issues-report.md).
`;
}

// ---------------------------------------------------------------------------
// sandbox-context.md generation
// ---------------------------------------------------------------------------

function testCommandLine(
  feature: string,
  svc: string,
  servicesConfig: ServicesConfig,
  archetypes: ArchetypeRegistry,
): string {
  const cmd = serviceTestCommand(svc, servicesConfig[svc], archetypes);
  return cmd
    ? `- \`${svc}\`: \`${containerTestCommand(feature, svc, cmd)}\``
    : `- \`${svc}\`: no test command registered (add \`test:\` to its registry entry)`;
}

/**
 * Render .sandbox/sandbox-context.md — how to validate, then (when they apply)
 * ports, service topology, lifecycle commands, health checks.
 *
 * `candidates` is the workspace's services (selected, else its repos'); routing
 * and Caddy sections appear only for those with a URL.
 */
export function buildSandboxContextMd(
  feature: string,
  slot: number,
  portStart: number,
  portEnd: number,
  localServices: string[],
  servicesConfig: ServicesConfig,
  testPath = "",
  archetypes: ArchetypeRegistry | null = null,
  candidates: string[] = localServices,
  autoStop = false,
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
  let urlHosts: string[] = [];
  let urlServices = new Set<string>();
  try {
    const routers = loadFeatureRouters(servicesConfig);
    const hostsOf = (svcs: string[]) =>
      svcs
        .map((svc) => routers[svc]?.hostname)
        .filter((h): h is string => Boolean(h))
        .sort();
    localHosts = hostsOf(localServices);
    urlHosts = hostsOf(candidates);
    urlServices = new Set(candidates.filter((svc) => routers[svc]?.hostname));
  } catch {
    localHosts = [];
  }
  // A service is URL-addressed when it has a feature_router host; only those get
  // Caddy/cookie routing. The rest are validated by their test/validate guidance.
  const hasLocal = localServices.length > 0;
  const hasUrl = urlServices.size > 0;
  const validationTable =
    "| Service | Repo | Path in repo | Test command | Validation |\n" +
    "|---------|------|--------------|--------------|------------|\n" +
    validationRows(candidates, servicesConfig, archetypes, urlServices)
      .map(
        (r) =>
          `| \`${r.service}\` | ${r.repo} | \`${r.path}\` | ${r.test ? `\`${r.test}\`` : "—"} | ${r.validate} |`,
      )
      .join("\n");

  const k8sPort = (svc: string): number | null => {
    // k8s-forwards container listen-port; single source is services.yaml.
    const svcDef = servicesConfig[svc] ?? {};
    if (
      isDict(svcDef) &&
      svcDef["k8s_forward_port"] !== null &&
      svcDef["k8s_forward_port"] !== undefined
    ) {
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
    if (firstLocalHostPort === null && urlServices.has(svc)) {
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
    // Local containers get every k8s service's URL injected, so their table keeps
    // them all. With none running, only the workspace's own services are relevant.
    if (!hasLocal && !candidates.includes(svc)) {
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

### Test commands

The registry's \`test:\` for each service (or its archetype's), run in its container — the worktree is mounted at \`/app\` with its \`node_modules\`; the host checkout has none. The pre-PR gate runs these (\`sandbox pr gate\`).

${svcs.map((s) => testCommandLine(feature, s, servicesConfig, archetypes ?? loadArchetypes())).join("\n")}

`;
  } else {
    containerCommandsBlock = "";
  }

  // Quick health checks — direct-to-localhost line must hit a real local
  // service port, not `port_start` (the slot base) where nothing listens.
  let healthChecks: string;
  if (firstLocalHostPort !== null) {
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
  } else if (hasLocal) {
    healthChecks =
      "# Container status:\n" +
      `docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}" | grep ${feature}`;
  } else {
    healthChecks =
      "# Through Caddy (all traffic routes to k8s):\n" +
      urlHosts
        .map(
          (host) =>
            'curl -sk -o /dev/null -w "HTTP %{http_code} | Size: %{size_download}\\n" ' +
            `"https://${host}/"\n`,
        )
        .join("")
        .trimEnd();
  }

  // The feature URL + routing cookie snippet CLAUDE.md used to carry — prefers
  // a host this feature actually runs, else falls back to any routed host.
  const proxy = resolveProxyHost(localServices);
  const featureBlock = proxy
    ? `
**Feature URL:** https://${proxy.host}/${testPath.replace(/^\/+/, "")}

Set the routing cookie in the browser (DevTools console):

\`\`\`js
document.cookie = "X-Feature=${feature}; domain=.${proxy.domain}; path=/; SameSite=Lax";
\`\`\`

or visit https://${proxy.host}/__werkmeister and select \`${feature}\` — the selector is served on every routed host and the cookie applies to each host sharing the base domain.
`
    : "";

  const validateBlock = `## How to validate

How to exercise a change to each service in this workspace.

${validationTable}

`;
  const slotBlock = hasLocal
    ? `## Slot & Port Range

- **Slot:** ${slot}
- **Port range:** ${portStart}–${portEnd}

`
    : "";
  const lifecycleBlock = hasLocal
    ? `## Container Lifecycle

Run from anywhere in the workspace — \`sandbox\` reads \`FEATURE\` from \`.env\` at the workspace root.

\`\`\`bash
sandbox up          # start containers + configure Caddy proxy
sandbox stop        # stop (slot preserved, fast resume)
sandbox restart     # restart all containers
sandbox down        # tear down + release slot
sandbox down -v     # tear down + remove volumes (node_modules, caches)
\`\`\`
${
  autoStop
    ? `
**Auto-stop is on** (\`auto_stop: true\` in \`.sandbox/workspace.yml\`): when a Claude session here ends and no other session is open in this workspace, a SessionEnd hook runs \`sandbox stop --if-idle\`, which stops this feature's containers (slot and volumes kept — \`sandbox up\` resumes). Shared infra is never stopped.
`
    : ""
}
> **Fallback:** If \`sandbox\` CLI is unavailable, \`docker compose up -d --build\` / \`docker compose down\` from the workspace root works equivalently. Prefer \`sandbox\` — it also manages slot allocation and Caddy proxy regeneration.

`
    : "";
  const servicesBlock =
    hasLocal || serviceRows.length > 0
      ? `## Services

Every container gets each service's URL injected as an env var (the last column). Local services resolve to the Docker DNS alias on the per-feature network; k8s-forwarded services resolve via the shared \`k8s-forwards\` container.

${servicesTable}

`
      : "";
  const healthBlock =
    hasUrl || hasLocal
      ? `## Quick Health Checks

\`\`\`bash
${healthChecks}
\`\`\`

`
      : "";
  const proxyBlock = hasUrl
    ? `## Proxy Routing

${routingHostList}

Set \`X-Feature=${feature}\` (cookie or header) to route to this workspace's local containers; otherwise traffic falls through to the k8s port-forwards.
${featureBlock}
`
    : "";
  const troubleshootingBlock =
    hasUrl || hasLocal
      ? `## Troubleshooting

${
  hasUrl
    ? `### Feature missing from \`/__werkmeister\` selector

The dropdown is populated from \`~/.werkmeister/infra/proxy/features.json\` (a static file served by Caddy), which is regenerated alongside the Caddyfile. It can drift from the live container labels (\`com.sandbox.local.feature\` — the source of truth) if a slot is allocated without a proxy regen.

Diagnose — compare what's labeled vs. what the UI shows:
\`\`\`bash
docker ps -a --filter label=com.sandbox.local.feature   --format '{{ .Label "com.sandbox.local.feature" }}' | sort -u
jq '[.[].name]' "$HOME/.werkmeister/infra/proxy/features.json"
\`\`\`

Resync:
\`\`\`bash
sandbox proxy-reload      # regenerates Caddyfile + features.json, reloads Caddy
\`\`\`

### Caddy returns \`content-length: 0\` but direct service hit works

Caddy routing issue, not an app issue. Try \`sandbox proxy-reload\` first; if Caddy is still misrouting, check \`docker logs sandbox-caddy --tail 50\`.

`
    : ""
}${
  hasLocal
    ? `### Containers expected per the table above are missing from \`docker ps\`

\`sandbox up\` may have partially failed. Re-run from the workspace root:
\`\`\`bash
sandbox up                # idempotent — starts missing containers
docker compose logs -f    # watch startup if something crashes
\`\`\`
`
    : ""
}`
      : "";

  return `<!--
  AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
  Source:    ~/.werkmeister/services.yaml + ports.yaml
             + .sandbox/workspace.yml (feature, services, slot)
  Generator: packages/werkmeister-core/src/claude_md.ts :: buildSandboxContextMd
  Regen:     sandbox init-workspace  (or \`sandbox up\` after slot changes)
  To change ports/health endpoints/services, edit services.yaml / ports.yaml.
  To change which services run locally, edit .sandbox/workspace.yml and rerun.
-->

# Sandbox Context: ${feature}

${validateBlock}${slotBlock}${lifecycleBlock}${servicesBlock}${containerCommandsBlock}${healthBlock}${proxyBlock}${troubleshootingBlock}`;
}
