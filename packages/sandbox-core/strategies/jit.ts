/**
 * The `jit` context strategy — docs/jit-context-system.md §5–6. What was
 * initWorkspace steps 5b–6c: active standards + gate manifest, notes +
 * CLAUDE.md, sb-* skills, generated agents, hooks. 5b, 6, 6a and 6c moved
 * verbatim; 6b's present-archetype resolution now goes through the shared
 * `presentArchetypes` helper (archetypes.ts) instead of calling
 * `resolvePresentArchetypes` inline.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { buildTesterSpecs, writeWorkspaceAgents } from "../agent_gen.js";
import { presentArchetypes } from "../archetypes.js";
import { buildClaudeMd, buildStandardsRoutingSection } from "../claude_md.js";
import { loadArchetypes } from "../config.js";
import { main as gateMain, resetSessionState } from "../gate.js";
import { standardsDirPath, standardsDirProblem } from "../global_config.js";
import { writeWorkspaceHooks } from "../hooks_gen.js";
import { buildContext, listNotes, nextNoteNumber, noteFilename, notesDir } from "../notes.js";
import { info, success, warn } from "../reporter.js";
import {
  buildStandardsManifest,
  loadStandardsModules,
  resolveActiveStandards,
  validateServiceStandards,
  writeStandardsManifest,
} from "../standards.js";
import { WORK_TYPE_PHASES, loadConfigFile, loadSandboxServiceConfigs } from "../workspace_prompts.js";
import {
  checkSkills,
  checkStandardsManifest,
  syncSkills,
  writeWorkspaceSkills,
} from "../workspace_skills.js";
import type { ContextStrategy, InitContext } from "./types.js";

const _LEGACY_HANDOFF_PLACEHOLDER = "*No handoff notes yet.*";

/** Rescue a filled-in legacy `## Handoff Notes` section into a note. */
function salvageLegacyHandoffNotes(workspaceRoot: string, claudeMdPath: string): void {
  if (!fs.existsSync(claudeMdPath)) {
    return;
  }
  try {
    const existing = fs.readFileSync(claudeMdPath, "utf8");
    const match = /^## Handoff Notes\n(?<body>[\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(existing);
    if (!match) {
      return;
    }
    const body = (match.groups!["body"] ?? "").trim();
    if (!body || body.includes(_LEGACY_HANDOFF_PLACEHOLDER)) {
      return;
    }

    const directory = notesDir(workspaceRoot);
    fs.mkdirSync(directory, { recursive: true });
    const filename = noteFilename(nextNoteNumber(directory), "contract", "migrated-handoff-notes");
    fs.writeFileSync(
      path.join(directory, filename),
      "---\n" +
        "type: contract\n" +
        "phase: implement\n" +
        "author: main\n" +
        "refs: []\n" +
        "status: open\n" +
        "---\n\n" +
        "Salvaged from the legacy CLAUDE.md `## Handoff Notes` section on regen.\n\n" +
        `${body}\n`,
    );
    success(`Salvaged legacy Handoff Notes → .sandbox/notes/${filename}`);
  } catch (exc) {
    warn(`Could not salvage legacy Handoff Notes: ${(exc as Error).message}`);
  }
}

/** Seed the workspace's first handoff note from creation-time inputs. */
function seedStartingHandoff(workspaceRoot: string, startingPrompt: string, workType: string): void {
  const prompt = startingPrompt.trim();
  const wt = workType.trim().toLowerCase();
  if (!prompt && !wt) {
    return;
  }
  const [phase, firstSkill] = WORK_TYPE_PHASES[wt] ?? ["research", "invoke `sb-research` first"];
  try {
    const directory = notesDir(workspaceRoot);
    const existing = listNotes(workspaceRoot, true);
    if (existing.some((note) => note.type === "handoff")) {
      return;
    }
    fs.mkdirSync(directory, { recursive: true });
    const filename = noteFilename(nextNoteNumber(directory), "handoff", "starting-prompt");
    const lines = [
      "---",
      "type: handoff",
      `phase: ${phase}`,
      "author: workspace-creation",
      "refs: []",
      "status: open",
      "---",
      "",
      "# Handoff: workspace creation",
      "",
    ];
    if (wt) {
      lines.push(`This workspace is a ${wt} — ${firstSkill}.`, "");
    }
    if (prompt) {
      lines.push(
        "Seeded from `starting_prompt` in .sandbox/workspace.yml when the",
        "workspace was created. The task below has not begun — confirm",
        "direction with the user before executing it.",
        "",
        prompt,
      );
    } else {
      lines.push("Seeded at workspace creation (no starting prompt was provided).");
    }
    fs.writeFileSync(path.join(directory, filename), lines.join("\n") + "\n");
    success(`Seeded starting handoff → .sandbox/notes/${filename}`);
  } catch (exc) {
    warn(`Could not seed starting handoff: ${(exc as Error).message}`);
  }
}

function init(ctx: InitContext): void {
  const { workspaceRoot, workspaceName, repos, task, meta, inputs, hasServiceMap, configOverride } = ctx;
  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");

  // 5b. Resolve the workspace's active standards (docs/jit-context-system.md §4.1).
  let standardsSection: string | null = null;
  const modules = loadStandardsModules();
  if (Object.keys(modules).length) {
    const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
    for (const err of validateServiceStandards(servicesConfig, modules)) {
      warn(err);
    }
    const workspaceConfig = loadConfigFile(workspaceRoot, configOverride);
    const repoNames = repos.map(([name]) => name);
    const localServices = (meta["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter((s) => s);
    const [active, notActive] = resolveActiveStandards(
      repoNames,
      servicesConfig,
      reposConfig,
      workspaceConfig,
      modules,
      localServices,
    );
    standardsSection = buildStandardsRoutingSection(active, notActive, modules, repoNames);
    info(`Standards routing: active = ${active.join(", ")}`);
    // PreToolUse standards gate manifest.
    writeStandardsManifest(workspaceRoot, buildStandardsManifest(active, modules));
  } else {
    // Not fatal — a workspace without standards still works — but it is a
    // materially degraded one (no routing table, no sb-*-standard skills, no
    // gate manifest), and it used to happen in silence.
    warn(
      standardsDirProblem() ||
        `no standard modules found in ${standardsDirPath()} — this workspace gets no ` +
          `standards routing, skills, or edit-time gate`,
    );
  }

  // 6. Write CLAUDE.md. The notes directory is created; legacy free-text Handoff
  // Notes content is salvaged first, then the starting prompt / work type is
  // seeded as the first handoff note if the workspace has none yet.
  fs.mkdirSync(notesDir(workspaceRoot), { recursive: true });
  salvageLegacyHandoffNotes(workspaceRoot, claudeMdPath);
  seedStartingHandoff(workspaceRoot, inputs["starting_prompt"] ?? "", inputs["work_type"] ?? "");
  const content = buildClaudeMd(
    workspaceName,
    workspaceRoot,
    repos,
    task,
    meta,
    hasServiceMap,
    standardsSection,
  );
  fs.writeFileSync(claudeMdPath, content);
  success(`Wrote ${claudeMdPath}`);

  // 6a. Projected sb-* skills into .claude/skills/.
  for (const skillPath of writeWorkspaceSkills(workspaceRoot)) {
    success(`Wrote ${skillPath}`);
  }

  // 6b. Generated subagents: sb-researcher plus one sb-tester-<archetype> per
  // archetype present.
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const archetypes = loadArchetypes();
  const present = presentArchetypes(repos, meta, servicesConfig, reposConfig, archetypes);
  const testerSpecs = buildTesterSpecs(present, servicesConfig, archetypes);
  for (const agentPath of writeWorkspaceAgents(workspaceRoot, testerSpecs)) {
    success(`Wrote ${agentPath}`);
  }

  // 6c. SessionStart hook. Merges into settings.json, never clobbers.
  const hooksPath = writeWorkspaceHooks(workspaceRoot);
  success(`Wrote ${hooksPath}`);
}

export const jit: ContextStrategy = {
  id: "jit",
  init,
  refresh(workspaceRoot) {
    // init-workspace is otherwise the only writer, so a workspace created before
    // a hook-template change kept the stale hook until someone re-ran it by hand.
    // The merge is idempotent and never clobbers a hand-added entry.
    writeWorkspaceHooks(workspaceRoot);
  },
  check(workspaceRoot) {
    const { authoring, drift } = checkSkills(workspaceRoot);
    // After the projected-skill report, because resolving the manifest logs.
    const manifestDrift = checkStandardsManifest(workspaceRoot);
    return [...authoring, ...drift, ...(manifestDrift === null ? [] : [manifestDrift])];
  },
  sync(workspaceRoot) {
    const { written, manifestPath } = syncSkills(workspaceRoot);
    return { wrote: manifestPath === null ? written : [...written, manifestPath] };
  },
  sessionContext(workspaceRoot, payload) {
    const source = String(payload["source"] || "");
    // Standards gate (docs/jit-context-system.md §6):
    // compact/clear wipe the context, so delivered standards must re-gate.
    if (source === "compact" || source === "clear") {
      resetSessionState(workspaceRoot, String(payload["session_id"] || ""));
    }
    return buildContext(workspaceRoot, source) || null;
  },
  gate: gateMain,
  ownedPaths: () => [
    "CLAUDE.md",
    ".claude/settings.json",
    ".claude/skills/sb-*",
    ".claude/agents/sb-*",
    ".sandbox/notes",
    ".sandbox/standards.json",
    ".sandbox/.gate",
  ],
};
