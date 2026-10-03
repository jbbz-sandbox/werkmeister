/** package.json → the dev command, test command, type/archetype and a fallback image. */
import * as path from "node:path";

import { readJson, readText } from "./files.js";
import { guessed, stated, type DetectContext, type Finding, type Workspace } from "./types.js";

const WEB_DEPS = ["next", "vite", "react", "expo"];
const API_DEPS = ["express", "fastify", "@nestjs/core", "koa"];
/** Ship glibc-only prebuilds; an alpine image can't load them (users guide, "Self-hosting the sandbox repo"). */
const GLIBC_ONLY = ["sharp", "better-sqlite3", "esbuild", "@swc/core"];

function testCommand(ws: Workspace, dir: string, pkgName: string | undefined): string {
  if (dir === ".") return `${ws.pm} test`;
  const name = pkgName ?? dir;
  if (ws.pm === "pnpm") return `pnpm --filter ${name} test`;
  if (ws.pm === "yarn") return `yarn workspace ${name} test`;
  return `npm test -w ${name}`;
}

function nodeMajor(ctx: DetectContext, dir: string, pkg: Record<string, any>, rootPkg: Record<string, any> | null): string {
  for (const range of [pkg.engines?.node, rootPkg?.engines?.node]) {
    const m = /(\d+)/.exec(String(range ?? ""));
    if (m) return m[1];
  }
  for (const rc of [path.posix.join(dir, ".nvmrc"), ".nvmrc"]) {
    if (!ctx.files.includes(rc)) continue;
    const m = /(\d+)/.exec(readText(ctx, rc));
    if (m) return m[1];
  }
  return "22";
}

export function detectPackages(ctx: DetectContext, ws: Workspace): Finding[] {
  const rootPkg = readJson(ctx, "package.json");
  const dirs = ws.packageDirs.length ? ws.packageDirs : rootPkg ? ["."] : [];
  const out: Finding[] = [];
  for (const dir of dirs) {
    const file = dir === "." ? "package.json" : `${dir}/package.json`;
    const pkg = readJson(ctx, file);
    if (!pkg) continue;
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
    const fields: Finding["fields"] = {};

    const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
    if (script) {
      const runIt = `exec ${ws.pm} run ${script}`;
      fields.command = stated(dir === "." ? runIt : `cd ${dir} && ${runIt}`, `${file} → scripts.${script}`);
    }
    if (scripts.test) fields.test = stated(testCommand(ws, dir, pkg.name), `${file} → scripts.test`);

    const web = WEB_DEPS.find((d) => d in deps);
    const api = API_DEPS.find((d) => d in deps);
    const marker: [string, string, string] | null = web
      ? ["web", "node-web", `${file} → dependency ${web}`]
      : api
        ? ["api", "node-service", `${file} → dependency ${api}`]
        : pkg.bin
          ? ["cli", "node-tool", `${file} → bin`]
          : null;
    if (marker) {
      fields.type = stated(marker[0], marker[2]);
      fields.archetype = stated(marker[1], marker[2]);
    } else {
      const why = `no web, api or bin marker in ${file} — assumed a service`;
      fields.type = guessed("api", why);
      fields.archetype = guessed("node-service", why);
    }

    const glibc = GLIBC_ONLY.find((d) => d in deps);
    fields.image = guessed(
      `node:${nodeMajor(ctx, dir, pkg, rootPkg)}${glibc ? "" : "-alpine"}`,
      `no Dockerfile — Node major from engines/.nvmrc${glibc ? `; glibc image because of ${glibc}` : ""}`,
    );
    if (ws.setupName) {
      fields.setup_service = stated(ws.setupName, "shared workspace install");
      fields.node_modules_volume = stated("node-modules", "shared workspace install");
    }
    out.push({
      kind: "package",
      name: dir === "." ? path.basename(ctx.root) : path.posix.basename(dir),
      dir,
      file,
      runnable: Boolean(script),
      fields,
    });
  }
  return out;
}
