/** The last gate before writing: the JSON Schema, then a trial merge with every other fragment. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import AjvModule from "ajv";
import { parse as parseYaml } from "yaml";

import { sandboxRoot } from "../config.js";
import { discoverFragments, mergeRegistry, RegistryError } from "../registry_sync.js";
import type { Plan } from "./plan.js";
import type { Rendered } from "./render.js";

// ajv is CJS: under Node ESM the default import is the module object, and under esbuild it's the class.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule;

export function defaultSchemaPath(): string {
  return path.join(sandboxRoot(), "infra", "schemas", "services-fragment.schema.json");
}

export function validateFragment(
  rendered: Rendered,
  plan: Plan,
  reposRoot: string,
  schemaPath = defaultSchemaPath(),
): string[] {
  let doc: Record<string, any>;
  try {
    doc = parseYaml(rendered.yaml) ?? {};
  } catch (e) {
    return [`generated YAML does not parse: ${e instanceof Error ? e.message : String(e)}`];
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    JSON.parse(fs.readFileSync(schemaPath, "utf8")),
  );
  const errors = validate(doc)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  try {
    const others = discoverFragments(reposRoot).filter(
      (f) => path.resolve(f.path) !== path.resolve(plan.fragmentPath),
    );
    mergeRegistry([...others, { repo: plan.repo, path: plan.fragmentPath, doc }], {
      defaults: {},
      local: {},
      paths: { home: os.homedir(), repos_root: reposRoot, workspaces_root: reposRoot },
    });
  } catch (e) {
    if (!(e instanceof RegistryError)) throw e;
    errors.push(e.message);
  }
  return errors;
}

export function writeFragment(rendered: Rendered): void {
  fs.mkdirSync(path.dirname(rendered.path), { recursive: true });
  fs.writeFileSync(rendered.path, rendered.yaml);
}
