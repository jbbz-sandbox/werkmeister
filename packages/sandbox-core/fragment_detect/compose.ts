/** docker-compose files → per-service environment, depends_on, command, port and health path. */
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { readText } from "./files.js";
import { stated, type DetectContext, type Finding } from "./types.js";

export const COMPOSE_FILE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/;

/** The container side of a compose port spec. */
export function containerPort(spec: unknown): number | undefined {
  if (typeof spec === "number") return Number.isInteger(spec) && spec > 0 ? spec : undefined;
  if (typeof spec === "string") {
    const last = (spec.split(":").pop() ?? "").split("/")[0].split("-")[0];
    const n = Number(last);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  if (spec && typeof spec === "object") {
    const target = (spec as Record<string, unknown>).target;
    return typeof target === "number" && Number.isInteger(target) ? target : undefined;
  }
  return undefined;
}

function envMap(env: unknown): Record<string, string> {
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map(String).filter((e) => e.includes("=")).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
    );
  }
  if (env && typeof env === "object") {
    return Object.fromEntries(
      Object.entries(env as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
  }
  return {};
}

function healthPath(hc: unknown): string | undefined {
  const t = (hc as Record<string, unknown> | undefined)?.test;
  const text = Array.isArray(t) ? t.join(" ") : String(t ?? "");
  return /https?:\/\/[^/\s"']+(\/[^\s"']*)/.exec(text)?.[1];
}

export function detectCompose(ctx: DetectContext): Finding[] {
  const out: Finding[] = [];
  for (const file of ctx.files.filter((f) => COMPOSE_FILE.test(f))) {
    let doc: any;
    try {
      doc = parseYaml(readText(ctx, file), { merge: true });
    } catch (e) {
      ctx.skipped.push({ item: file, reason: `unparsable YAML: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    for (const [name, raw] of Object.entries(doc?.services ?? {})) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, any>;
      const src = (field: string) => `${file} → services.${name}.${field}`;
      const context = typeof s.build === "string" ? s.build : s.build?.context;
      const dir =
        context === undefined
          ? null
          : path.posix.normalize(path.posix.join(path.posix.dirname(file), String(context))).replace(/\/$/, "") || ".";
      const fields: Finding["fields"] = {};

      const env = envMap(s.environment);
      if (Object.keys(env).length) fields.environment = stated(env, src("environment"));
      const deps = Array.isArray(s.depends_on)
        ? s.depends_on.map(String)
        : s.depends_on && typeof s.depends_on === "object"
          ? Object.keys(s.depends_on)
          : [];
      if (deps.length) fields.depends_on = stated([...deps].sort(), src("depends_on"));
      if (s.command !== undefined) {
        fields.command = stated(Array.isArray(s.command) ? s.command.join(" ") : String(s.command), src("command"));
      }
      const port = containerPort(s.ports?.[0]) ?? containerPort(s.expose?.[0]);
      if (port) fields.internal_port = stated(port, src(s.ports ? "ports" : "expose"));
      const health = healthPath(s.healthcheck);
      if (health) fields.health_endpoint = stated(health, src("healthcheck"));

      out.push({ kind: "compose", name, dir, file, ...(s.image ? { image: String(s.image) } : {}), fields });
    }
  }
  return out;
}
