/** The last gate before writing: the JSON Schema, then a trial merge with every other fragment. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import AjvModule from "ajv";
import { parse as parseYaml } from "yaml";

import { sandboxHome, sandboxRoot, servicesLocalYamlPath } from "../config.js";
import { loadIngress } from "../global_config.js";
import {
  applyDisabled,
  discoverFragments,
  mergeRegistry,
  RegistryError,
  readLocalOverlay,
} from "../registry_sync.js";
import type { Plan } from "./plan.js";
import type { Rendered } from "./render.js";

// ajv is CJS: under Node ESM the default import is the module object, and under esbuild it's the class.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ??
  AjvModule) as typeof AjvModule;

export function defaultSchemaPath(): string {
  return path.join(sandboxRoot(), "infra", "schemas", "services-fragment.schema.json");
}

/**
 * Checks a rendered fragment before you write it: first against the fragment JSON
 * Schema, then by trial-merging it with every other repo's fragment under `reposRoot`,
 * which catches clashes such as a duplicate service name. Repos the machine overrides
 * file lists under `disabled_fragments` are left out, as `werkmeister registry sync`
 * leaves them out. Runs in-process and writes nothing.
 *
 * @param rendered - The fragment from {@link renderFragment}.
 * @param plan - The plan it was rendered from. The file at its `fragmentPath` is left out of the merge, so the old copy can't clash with the new one.
 * @param reposRoot - Directory holding every registered repo.
 * @param schemaPath - The fragment JSON Schema file. Defaults to the one in the werkmeister install.
 * @param localPath - The machine overrides file whose `disabled_fragments` names the repos to leave out. Defaults to `services.local.yaml` beside the registry.
 * @returns The problems found, one sentence each. Empty means the fragment is safe to write.
 * @throws `Error` when the schema file can't be read, or when the merge fails for a reason other than a registry conflict.
 *
 * @example
 * ```ts
 * import {
 *   planFragment,
 *   renderFragment,
 *   validateFragment,
 *   writeFragment,
 * } from "werkmeister-core/sdk";
 *
 * const reposRoot = "/home/me/repos";
 * const plan = planFragment(`${reposRoot}/my-app`, {
 *   reposRoot,
 *   runner: () => [1, ""],
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: 20,
 * });
 * const rendered = renderFragment(plan);
 * const problems = validateFragment(rendered, plan, reposRoot);
 * if (problems.length) console.error(problems.join("\n"));
 * else if (rendered.changed) writeFragment(rendered);
 * ```
 */
export function validateFragment(
  rendered: Rendered,
  plan: Plan,
  reposRoot: string,
  schemaPath = defaultSchemaPath(),
  localPath = servicesLocalYamlPath(),
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
    const discovered = discoverFragments(reposRoot).filter(
      (f) => path.resolve(f.path) !== path.resolve(plan.fragmentPath),
    );
    // A repo this machine disabled never reaches the registry, so its clashes are not this fragment's.
    const others = applyDisabled(discovered, readLocalOverlay(localPath), localPath).fragments;
    mergeRegistry([...others, { repo: plan.repo, path: plan.fragmentPath, doc }], {
      defaults: {},
      local: {},
      paths: {
        home: os.homedir(),
        repos_root: reposRoot,
        workspaces_root: reposRoot,
        werkmeister_home: sandboxHome(),
        local_domain: loadIngress().local_domain,
      },
    });
  } catch (e) {
    if (!(e instanceof RegistryError)) throw e;
    errors.push(e.message);
  }
  return errors;
}

/**
 * Writes a rendered fragment to `rendered.path`, creating the repo's `.werkmeister/`
 * folder if needed and replacing any file already there. Runs in-process. Check the
 * fragment with {@link validateFragment} first, and skip the write when
 * `rendered.changed` is false.
 *
 * @param rendered - The fragment from {@link renderFragment}.
 * @throws `Error` from the file system when the folder or file can't be written.
 *
 * @example
 * ```ts
 * import { planFragment, renderFragment, writeFragment } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: () => [1, ""],
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: 20,
 * });
 * const rendered = renderFragment(plan);
 * if (rendered.changed) writeFragment(rendered);
 * console.log(`added: ${rendered.added.join(", ") || "nothing"}`);
 * ```
 */
export function writeFragment(rendered: Rendered): void {
  fs.mkdirSync(path.dirname(rendered.path), { recursive: true });
  fs.writeFileSync(rendered.path, rendered.yaml);
}
