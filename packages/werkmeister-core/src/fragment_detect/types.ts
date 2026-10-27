/**
 * Shared shapes for `werkmeister detect`. Detectors emit Findings, correlation
 * groups them into services, and precedence turns each group into fields.
 * See docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md at 66703fc. // name-check: ignore
 */
import type { Runner } from "../machine_setup.js";

export type Confidence = "stated" | "guessed" | "inferred";

/** One field value and where it came from. For a guess, `source` is the reason written as the YAML comment. */
export interface FieldValue {
  value: unknown;
  source: string;
  confidence: Confidence;
}

export type FindingKind = "package" | "dockerfile" | "k8s" | "compose";

/** What one file says about one would-be service, before correlation. */
export interface Finding {
  kind: FindingKind;
  /** Candidate service name: package dir basename, Deployment/release name or compose service name. */
  name: string;
  /** Repo-relative directory the finding is anchored to ("." is the repo root), or null. */
  dir: string | null;
  /** Repo-relative file it came from (or a label such as `x.values.yaml (helm template)`). */
  file: string;
  /** Container image, used for matching and datastore detection (k8s, compose). */
  image?: string;
  /** Package findings only: has a `dev` or `start` script. */
  runnable?: boolean;
  fields: Record<string, FieldValue>;
}

export interface Skipped {
  item: string;
  reason: string;
}

export interface DetectContext {
  /** Absolute repo root. */
  root: string;
  /** Repo-relative POSIX paths, sorted. */
  files: string[];
  runner: Runner;
  /** Detectors record a bad file here instead of throwing. */
  skipped: Skipped[];
}

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface Workspace {
  pm: PackageManager;
  /** Repo-relative package dirs; [] when the repo has no workspaces. */
  packageDirs: string[];
  /** The shared install setup service, or null when there is no root package.json. */
  setupName: string | null;
  setupFields: Record<string, FieldValue>;
}

export function stated(value: unknown, source: string): FieldValue {
  return { value, source, confidence: "stated" };
}

export function guessed(value: unknown, source: string): FieldValue {
  return { value, source, confidence: "guessed" };
}
