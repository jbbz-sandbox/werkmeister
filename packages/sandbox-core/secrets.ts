/**
 * Required-secret validation for the developer sandbox.
 *
 * A service in services.yaml declares the secret keys it needs via an
 * optional `secrets: [KEY, ...]` list. `sandbox up` requires only the keys
 * declared by the services actually in the feature's own workspace (its
 * local `SERVICES=` list) -- a feature that uses no such services needs no
 * secrets.env entries at all. This replaces a fixed global key list, which
 * drifted from what services actually consume and blocked `up` on secrets no
 * service in the workspace needed.
 *
 * Never log or return secret VALUES from this module -- only key names.
 */

import * as fs from "node:fs";

import { secretsPath } from "./global_config.js";

/** Union of the `secrets:` keys declared by *serviceNames*, sorted. */
export function requiredSecretKeys(
  servicesConfig: Record<string, any>,
  serviceNames: readonly string[],
): string[] {
  const keys = new Set<string>();
  for (const name of serviceNames) {
    const svcDef = servicesConfig[name];
    const declared = svcDef && typeof svcDef === "object" ? svcDef.secrets : null;
    if (Array.isArray(declared)) {
      for (const key of declared) {
        keys.add(String(key));
      }
    }
  }
  return [...keys].sort();
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

/**
 * Return the sorted list of *required* keys that are missing or empty in
 * *secrets*.
 *
 * A key that is present but whose value is empty or whitespace-only counts
 * as missing. Never includes secret values -- only key names.
 */
export function validateRequiredSecrets(
  secrets: Record<string, string>,
  required: readonly string[],
): string[] {
  const missing = required.filter((key) => !(secrets[key] ?? "").trim());
  return [...missing].sort();
}
