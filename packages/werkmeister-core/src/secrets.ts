/**
 * Required-secret validation for the developer sandbox.
 *
 * A service in services.yaml declares the secret keys it needs via an
 * optional `secrets: [KEY, ...]` list, satisfied in secrets.env by
 * `<SERVICE>__KEY` or plain `KEY` (see `resolveSecrets`). `sandbox up`
 * requires only the keys declared by the services actually in the feature's
 * own workspace (its local `SERVICES=` list) -- a feature that uses no such
 * services needs no secrets.env entries at all. This replaces a fixed global key list, which
 * drifted from what services actually consume and blocked `up` on secrets no
 * service in the workspace needed.
 *
 * Never log secret VALUES -- anything reported (e.g. `missing`) carries key names only.
 */

import * as fs from "node:fs";
import type { ServicesConfig } from "./config.js";
import { secretsPath } from "./global_config.js";

/** Same rule as the generated `<PREFIX>_URL` keys: `werkmeister-core` → `SANDBOX_CORE`. */
export function secretPrefix(svcName: string): string {
  return svcName.toUpperCase().replace(/-/g, "_");
}

export interface ResolvedSecrets {
  /** Per service: declared KEY → value, written to that service's own env file as plain `KEY`. */
  byService: Record<string, Record<string, string>>;
  /** `PREFIX__KEY / KEY` for each declared key with no non-empty value. Names only. */
  missing: string[];
}

/**
 * Resolve each service's declared `secrets:` against *all* (secrets.env).
 *
 * *overrides* (workspace `env_vars`) win first: the most local config beats the
 * machine-global file. Then `<PREFIX>__KEY`, so two services can hold different
 * values under one name; plain `KEY` is the shared / pre-namespacing fallback.
 * An empty value counts as unset and falls through to the next source.
 */
export function resolveSecrets(
  all: Record<string, string>,
  servicesConfig: ServicesConfig,
  serviceNames: readonly string[],
  overrides: Record<string, string> = {},
): ResolvedSecrets {
  const byService: Record<string, Record<string, string>> = {};
  const missing = new Set<string>();
  for (const name of serviceNames) {
    const resolved: Record<string, string> = {};
    const svcDef = servicesConfig[name];
    const declared = svcDef && typeof svcDef === "object" ? svcDef.secrets : null;
    if (Array.isArray(declared)) {
      const prefix = secretPrefix(name);
      for (const raw of declared) {
        const key = String(raw);
        const namespaced = `${prefix}__${key}`;
        const value = [overrides[key], all[namespaced], all[key]].find((v) => (v ?? "").trim());
        if (value === undefined) {
          missing.add(`${namespaced} / ${key}`);
        } else {
          resolved[key] = value;
        }
      }
    }
    byService[name] = resolved;
  }
  return { byService, missing: [...missing].sort() };
}

/** Return the path to the real secrets file (`~/.sandbox/secrets.env`). */
export function getSecretsPath(): string {
  return secretsPath();
}

/**
 * Parse a secrets.env-format file into a dict.
 *
 * Mirrors the inline parsing in `generate.ts` (skip blank lines and
 * lines starting with `#`, split on the first `=`). Returns an empty
 * dict if *path* does not exist.
 */
export function loadSecrets(path: string): Record<string, string> {
  if (!(fs.existsSync(path) && fs.statSync(path).isFile())) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const idx = line.indexOf("=");
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    result[key.trim()] = value.trim();
  }
  return result;
}
