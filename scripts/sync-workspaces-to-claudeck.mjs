#!/usr/bin/env node
// On-demand sync: register every sandbox feature workspace as a claudeck project
// in folders.json — the flat project list the chat picker reads (/api/projects),
// so each workspace is selectable and chat roots at its dir. Idempotent and
// non-destructive: managed entries carry `source: "sandbox"`; manual entries and
// entries whose workspace is gone are preserved / pruned accordingly.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { listWorkspaces } from "sandbox-driver";
import { mergeFolders } from "./lib/merge-folders.mjs";

const userDir = process.env.CLAUDECK_HOME || join(homedir(), ".claudeck");
const configDir = join(userDir, "config");
const foldersFile = join(configDir, "folders.json");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return fallback;
  }
}

const write = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n");

export async function main() {
  const { workspaces } = await listWorkspaces();
  const nextFolders = mergeFolders(await readJson(foldersFile, []), workspaces);

  await mkdir(configDir, { recursive: true });
  await write(foldersFile, nextFolders);

  const managed = nextFolders.filter((e) => e?.source === "sandbox").length;
  console.log(`Synced ${managed} workspace(s) -> folders.json (${configDir})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
