/** Reading a repo for detection: the file list, and text/JSON/YAML readers. */
import * as fs from "node:fs";
import * as path from "node:path";

import { parseAllDocuments } from "yaml";

import type { Runner } from "../machine_setup.js";
import { ProcError, run } from "../proc.js";
import type { DetectContext } from "./types.js";

/** Dependencies and dot directories are never scanned; dotfiles such as .nvmrc are. */
function pruned(rel: string): boolean {
  const segs = rel.split("/");
  return segs.some((seg, i) => seg === "node_modules" || (i < segs.length - 1 && seg.startsWith(".")));
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      out.push(...walk(root, child));
    } else if (ent.isFile()) {
      out.push(child);
    }
  }
  return out;
}

/** Every file in the repo, repo-relative and sorted: git's view when it is a repo, a directory walk otherwise. */
export function listRepoFiles(root: string, runner: Runner): string[] {
  const [rc, out] = runner(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard"]);
  const files = rc === 0 ? out.split("\n").map((l) => l.trim()).filter(Boolean) : walk(root);
  // --cached lists tracked files deleted from the working tree.
  return files.filter((f) => !pruned(f) && fs.existsSync(path.join(root, f))).sort();
}

export function readText(ctx: DetectContext, rel: string): string {
  return fs.readFileSync(path.join(ctx.root, rel), "utf8");
}

/** A JSON object file, or null when the repo has no such file. Malformed JSON throws. */
export function readJson(ctx: DetectContext, rel: string): Record<string, any> | null {
  if (!ctx.files.includes(rel)) return null;
  const data = JSON.parse(readText(ctx, rel));
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

/** Every document in a YAML stream. A stream that doesn't parse throws with the parser's message. */
export function yamlDocs(text: string): unknown[] {
  return parseAllDocuments(text).map((doc) => {
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    return doc.toJS();
  });
}

/**
 * A Runner whose output is stdout alone on success. helm and kubectl print
 * warnings on stderr, which must not reach the YAML parser; on failure the
 * output is stderr, for the skipped-item message.
 */
export function stdoutRunner(cmd: string[]): [number, string] {
  try {
    const res = run(cmd, { capture: true, timeout: 120 });
    return [res.status, res.status === 0 ? res.stdout || "" : (res.stderr || res.stdout || "").trim()];
  } catch (e) {
    if (e instanceof ProcError && e.code === "ENOENT") return [127, `${cmd[0]}: command not found`];
    if (e instanceof ProcError && e.code === "ETIMEDOUT") return [124, `${cmd.join(" ")}: timed out`];
    throw e;
  }
}
