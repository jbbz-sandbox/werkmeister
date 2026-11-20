/**
 * Shared shapes for `werkmeister machine detect`. Detectors emit Findings, correlation
 * groups them into services, and precedence turns each group into fields.
 * See docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md at 66703fc. // name-check: ignore
 */
import type { Runner } from "../machine_setup.js";

/**
 * How far a detected field value can be trusted. `stated`: a file in the repo says so.
 * `guessed`: a heuristic picked it, so review it. `inferred`: an answer accepted by
 * {@link applyAnswers} supplied it.
 *
 * @example
 * ```ts
 * import type { Confidence } from "werkmeister-core/sdk";
 *
 * const needsReview = (c: Confidence): boolean => c !== "stated";
 * console.log(needsReview("guessed")); // true
 * ```
 */
export type Confidence = "stated" | "guessed" | "inferred";

/**
 * One planned field of a service or infrastructure entry, and where it came from.
 * {@link planFragment} fills a `Record<string, FieldValue>` per entry, keyed by the
 * `services.yaml` field name.
 *
 * @example
 * ```ts
 * import { type FieldValue, planFragment, portsPerSlot, stdoutRunner } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: stdoutRunner,
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: portsPerSlot(),
 * });
 * const command: FieldValue | undefined = plan.services[0]?.fields.command;
 * if (command) console.log(command.value, command.confidence, command.source);
 * ```
 */
export interface FieldValue {
  /** The value as it would be written to the fragment. */
  value: unknown;
  /** The file or rule it came from. For a guess, the reason, written into the fragment as a YAML comment. */
  source: string;
  /** How far the value can be trusted. */
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

/**
 * A file or detector that {@link planFragment} left out instead of failing on, such as
 * a manifest that doesn't parse. Listed in `Plan.skipped`.
 *
 * @example
 * ```ts
 * import { planFragment, portsPerSlot, type Skipped, stdoutRunner } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: stdoutRunner,
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: portsPerSlot(),
 * });
 * const skipped: Skipped[] = plan.skipped;
 * for (const s of skipped) console.warn(`skipped ${s.item}: ${s.reason}`);
 * ```
 */
export interface Skipped {
  /** The file or detector left out. */
  item: string;
  /** Why, as shown to the person. */
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
