/**
 * Required-secret validation for the developer sandbox.
 *
 * Owns the single source of truth for which secret keys `~/.sandbox/secrets.env`
 * must define, plus a loader and a validator used by `sandbox up` to fail fast,
 * before `docker compose up`, when a required key is missing or empty.
 *
 * `REQUIRED_SECRET_KEYS` below is also what lib/scaffold renders the seeded
 * secrets.env template from, so the template and this validator cannot drift
 * (the old committed `secrets.env.example` had to be hand-synced, and didn't).
 *
 * Never log or return secret VALUES from this module -- only key names.
 */

import * as fs from "node:fs";

import { secretsPath } from "./global_config.js";

// Secret keys that infra/templates/env.j2 references WITHOUT a usable default —
// i.e. their Jinja default is empty (`default('', true)`), so an unset value
// yields broken config (empty DB password, empty auth0 secret, ...). Those are
// the only keys worth failing `sandbox up` over.
//
// Keys that env.j2 defaults to a working dev placeholder (COOKIE_SECRET,
// ENCRYPTION_KEY, LOOKER_KEY, NEXT_PUBLIC_SEGMENT_WRITE_KEY) are intentionally
// OPTIONAL: the sandbox boots fine on those defaults, so requiring them was a
// regression that blocked `up` for anyone who hadn't filled them in.
// The secrets test derives this set from env.j2 to keep it honest.
export const REQUIRED_SECRET_KEYS: readonly string[] = [
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_MGMT_CLIENT_ID",
  "AUTH0_MGMT_CLIENT_SECRET",
  "ELASTIC_SEARCH_PASSWORD",
  "GITHUB_AUTH_TOKEN",
  "GROWTHBOOK_CLIENT_KEY",
  "MONGO_PASSWORD",
  "MONGO_USER",
  "NEXTAUTH_SECRET",
  "POSTGRES_PASSWORD",
  "TAXONOMY_API_KEY",
  // TinaCMS self-hosted backend secrets (PROJ-1896).
  "TINA_MONGO_PASSWORD",
  "TINA_MONGO_USER",
  "TINA_WRITE_SHARED_SECRET",
  "TRWEB_AUTH0_CLIENT_SECRET",
  "TRWEB_AUTH0_MGMT_CLIENT_SECRET",
  "TRWEB_AUTH0_SECRET",
];

/** Return the path to the real secrets file (`~/.sandbox/secrets.env`). */
export function getSecretsPath(): string {
  return secretsPath();
}

/**
 * Parse a secrets.env-format file into a dict.
 *
 * Mirrors the inline parsing in `lib/generate` (skip blank lines and
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
 * Return the sorted list of required keys that are missing or empty.
 *
 * A key that is present but whose value is empty or whitespace-only counts
 * as missing. Never includes secret values -- only key names.
 */
export function validateRequiredSecrets(secrets: Record<string, string>): string[] {
  const missing = REQUIRED_SECRET_KEYS.filter((key) => !(secrets[key] ?? "").trim());
  return [...missing].sort();
}
