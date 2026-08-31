/**
 * Generated workspace subagents — build-plan steps 2 and 4 of
 * docs/jit-context-system.md (§5.4).
 *
 * Emits agent definitions into each workspace's `.claude/agents/`:
 * `sb-researcher`, the workspace-shared read-only research agent spawned by
 * the `sb-research` entry skill (step 2), and one `sb-tester-<archetype>`
 * per archetype present in the workspace, spawned by `sb-test` (step 4).
 * Phase gates *tools*, archetype gates *context* (§5.4): every tester gets
 * the same test-phase toolset; what differs per archetype is the services, the
 * test commands, and which standard applies to test code.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { serviceTestCommand } from "./archetypes.js";

// Agent files must open with the frontmatter block, so the do-not-hand-edit
// notice goes in the body (it becomes part of the agent's prompt — kept to
// one screen line beyond the marker comment for that reason).
const _GENERATED_NOTICE = `<!--
  AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
  Generator: sandbox init-workspace  (packages/sandbox-core/agent_gen.ts)
  Regenerated on every init-workspace run; edits will be clobbered.
-->
`;

export const RESEARCHER_AGENT_NAME = "sb-researcher";

/** Render the sb-researcher agent definition (§5.4, §5.7). */
export function buildResearcherAgent(): string {
  return `---
name: ${RESEARCHER_AGENT_NAME}
description: Research agent for this workspace. Investigates code and reports
  findings with proposed fixes. Writes findings to .sandbox/notes/; never
  modifies source files.
tools: Read, Grep, Glob, Write
---

${_GENERATED_NOTICE}
You investigate code in this workspace and report findings. Do not modify
source files — the implement phase is a separate, user-invoked step. Your
Write tool exists solely for the note below.

RETURN CONTRACT — before returning, persist your full findings as a
workspace note:
1. List \`.sandbox/notes/\` and take the next free NNN sequence number
   (001 if the directory is missing or empty — create it; never renumber
   existing notes).
2. Write \`.sandbox/notes/NNN-finding-<short-slug>.md\` with this exact shape:
   ---
   type: finding
   phase: research
   author: ${RESEARCHER_AGENT_NAME}
   refs: [<files / services you investigated>]
   status: open
   ---
   # Finding: <title>
   <root cause, evidence with file:line refs, the exact proposed fix
   described in text, and OPEN QUESTIONS / AMBIGUITIES for the human to
   resolve>
3. Return only a 2-3 sentence summary, the note's path, and the OPEN
   QUESTIONS / AMBIGUITIES list. The note is the durable record; your reply
   is just the pointer.

Workspace context: read CLAUDE.md first (routing + standards tables).
`;
}

export const TESTER_AGENT_PREFIX = "sb-tester-";

/**
 * Assemble one tester-agent spec per archetype present in the workspace.
 *
 * Input is `resolvePresentArchetypes` output. Each spec carries what
 * `buildTesterAgent` renders: the archetype's services with their repo +
 * resolved test command, and the archetype's standards keys (the standard the
 * tester applies to test code it writes).
 */
export function buildTesterSpecs(
  presentArchetypes: Record<string, string[]>,
  servicesConfig: Record<string, any>,
  archetypes: Record<string, any>,
): Array<Record<string, any>> {
  const specs: Array<Record<string, any>> = [];
  for (const [archName, svcNames] of Object.entries(presentArchetypes)) {
    const arch = archetypes[archName] ?? {};
    const services: Array<Record<string, any>> = [];
    for (const svc of svcNames) {
      const svcDef = servicesConfig[svc] ?? {};
      services.push({
        name: svc,
        repo: svcDef["repo"],
        command: serviceTestCommand(svc, svcDef, archetypes),
      });
    }
    specs.push({
      archetype: archName,
      services,
      standards: [...(arch["standards"] ?? [])],
    });
  }
  return specs;
}

/** Render one sb-tester-<archetype> definition (§5.4). */
export function buildTesterAgent(spec: Record<string, any>): string {
  const archName = spec["archetype"];
  const services: Array<Record<string, any>> = spec["services"];
  const svcList = services.map((s) => s["name"]).join(", ");

  const commandLines: string[] = [];
  for (const svc of services) {
    if (svc["command"]) {
      commandLines.push(
        `- ${svc["name"]} — run from \`${svc["repo"]}/\`: \`${svc["command"]}\``,
      );
    } else {
      commandLines.push(
        `- ${svc["name"]} — no test command registered in services.yaml; ` +
          "say so instead of inventing one",
      );
    }
  }
  const commands = commandLines.join("\n");

  let standardsLine = "";
  if (spec["standards"] && spec["standards"].length) {
    const skills = (spec["standards"] as string[])
      .map((key) => `\`sb-${key}-standard\``)
      .join(", ");
    standardsLine =
      `\nWhen writing or editing test code, apply the ${skills} ` +
      "standard(s) — the workspace CLAUDE.md's Standards routing table " +
      "maps them.\n";
  }

  return `---
name: ${TESTER_AGENT_PREFIX}${archName}
description: Runs and interprets tests for this workspace's ${archName}
  services (${svcList}). Edits test files only; never touches application
  source.
tools: Read, Grep, Glob, Bash, Edit
---

${_GENERATED_NOTICE}
You run and interpret tests for this workspace's ${archName} services.

TEST COMMANDS — each runs from the named repo directory at the workspace
root:
${commands}

Edit only test files. Never modify application source — fixes belong to the
implement phase, a separate user-invoked step in the main conversation.
${standardsLine}
RETURN CONTRACT — report, per service tested:
- the exact command run and its pass/fail outcome;
- each failing test with the failing assertion (file:line) and your
  suspected cause;
- runs blocked for environment reasons (missing deps, service not
  bootstrapped) reported as BLOCKED with the error — do not "fix" the
  environment beyond running the tests;
- OPEN QUESTIONS / AMBIGUITIES for the human to resolve.

Workspace context: read CLAUDE.md first (routing + standards tables).
`;
}

/**
 * Write generated agent definitions; returns the paths written.
 *
 * Tester files for archetypes no longer present are removed — every
 * `sb-tester-*.md` here is a generated projection (the notice says so), so a
 * leftover from a previous service selection is stale output, not user content.
 */
export function writeWorkspaceAgents(
  workspaceRoot: string,
  testerSpecs?: Array<Record<string, any>> | null,
): string[] {
  const agentsDir = path.join(workspaceRoot, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const written: string[] = [path.join(agentsDir, `${RESEARCHER_AGENT_NAME}.md`)];
  fs.writeFileSync(written[0], buildResearcherAgent());

  for (const spec of testerSpecs ?? []) {
    const p = path.join(agentsDir, `${TESTER_AGENT_PREFIX}${spec["archetype"]}.md`);
    fs.writeFileSync(p, buildTesterAgent(spec));
    written.push(p);
  }

  const writtenSet = new Set(written);
  for (const entry of fs.readdirSync(agentsDir)) {
    if (entry.startsWith(TESTER_AGENT_PREFIX) && entry.endsWith(".md")) {
      const stale = path.join(agentsDir, entry);
      if (!writtenSet.has(stale)) {
        fs.unlinkSync(stale);
      }
    }
  }
  return written;
}
