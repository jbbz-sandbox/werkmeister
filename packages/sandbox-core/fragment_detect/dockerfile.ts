/** Dockerfile → the dev image (first FROM), the port (EXPOSE) and a guessed command (CMD/ENTRYPOINT). */
import * as path from "node:path";

import { readText } from "./files.js";
import { guessed, stated, type DetectContext, type Finding } from "./types.js";

const DOCKERFILE = /^(?!.*\.(md|dockerignore)$)(Dockerfile(\..+)?|.+\.Dockerfile)$/;
const DEV = /(^|\.)dev(\.|$)/i;

/** [INSTRUCTION, argument] pairs, with continuations joined and comments dropped. */
export function dockerInstructions(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\w+)\s+(.*)$/.exec(line);
    if (m) out.push([m[1].toUpperCase(), m[2].trim()]);
  }
  return out;
}

/** `["node", "server.js"]` → `node server.js`; shell form is returned as written. */
function commandText(arg: string): string {
  if (arg.startsWith("[")) {
    try {
      const parts = JSON.parse(arg);
      if (Array.isArray(parts)) return parts.map(String).join(" ");
    } catch {
      // Not valid exec form: fall through to the raw text.
    }
  }
  return arg;
}

export function detectDockerfiles(ctx: DetectContext): Finding[] {
  const isDev = (f: string) => DEV.test(path.posix.basename(f));
  const files = ctx.files
    .filter((f) => DOCKERFILE.test(path.posix.basename(f)))
    .sort((a, b) => Number(isDev(b)) - Number(isDev(a)) || a.localeCompare(b));
  return files.map((file) => {
    const dir = path.posix.dirname(file);
    const ins = dockerInstructions(readText(ctx, file));
    const fields: Finding["fields"] = {};

    // The first stage is the build stage, which carries the toolchain a dev container needs.
    const from = ins.find(([k]) => k === "FROM");
    const image = from?.[1].split(/\s+/).find((t) => !t.startsWith("--"));
    if (image && !image.includes("$")) fields.image = stated(image, `${file} → FROM`);

    const expose = ins.find(([k]) => k === "EXPOSE");
    const port = Number(/(\d+)/.exec(expose?.[1] ?? "")?.[1]);
    if (Number.isInteger(port) && port > 0) fields.internal_port = stated(port, `${file} → EXPOSE`);

    const last = (k: string) => [...ins].reverse().find(([name]) => name === k);
    const cmd = last("CMD") ?? last("ENTRYPOINT");
    if (cmd) {
      const text = commandText(cmd[1]);
      fields.command = guessed(
        dir === "." ? text : `cd ${dir} && exec ${text}`,
        `${file} → ${cmd[0]} is the production entrypoint`,
      );
    }
    return {
      kind: "dockerfile",
      name: dir === "." ? path.basename(ctx.root) : path.posix.basename(dir),
      dir,
      file,
      fields,
    };
  });
}
