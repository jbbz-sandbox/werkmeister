import { loadConfig } from "./config.js";

/** The daemon's SQS consumer settings: the `github_ingest:` block of ~/.werkmeister/config.yaml (SW-583). */
export interface GithubIngestConfig {
  queueUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the Lambda puts on the queue: the payload itself stays in GitHub, the daemon re-reads with `gh`. */
export interface IngestMessage {
  delivery: string;
  event: string;
  action: string | null;
  repo: string;
}

/**
 * Null (ingest off) without a `queue_url` or with any field empty. Config only: shell `AWS_*`
 * keys could pair with these or widen the receive/delete-only user's rights.
 */
export function githubIngestConfig(): GithubIngestConfig | null {
  let block: Record<string, unknown>;
  try {
    block = (loadConfig()["github_ingest"] ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const queueUrl = String(block.queue_url ?? "").trim();
  if (!queueUrl) return null;
  const cfg = {
    queueUrl,
    region: String(block.region ?? "").trim(),
    accessKeyId: String(block.access_key_id ?? "").trim(),
    secretAccessKey: String(block.secret_access_key ?? "").trim(),
  };
  return Object.values(cfg).every(Boolean) ? cfg : null;
}

export function parseIngestMessage(body: string): IngestMessage | null {
  try {
    const m = JSON.parse(body);
    if (typeof m?.delivery !== "string" || !m.delivery) return null;
    if (typeof m.repo !== "string" || !m.repo) return null;
    return {
      delivery: m.delivery,
      event: String(m.event ?? ""),
      action: typeof m.action === "string" ? m.action : null,
      repo: m.repo,
    };
  } catch {
    return null;
  }
}
