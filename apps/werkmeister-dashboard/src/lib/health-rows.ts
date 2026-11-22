import type { WorkspaceStatus } from "werkmeister-core";
import {
  type DisplayOptions,
  displayModel,
  type WorkspaceDisplay,
} from "werkmeister-ui/display-model";

/** Per workspace: what its PRs need and the phase note, from `workspace-prs` (SW-558). */
export type PrExtra = Record<string, Pick<DisplayOptions, "prNeeds" | "phaseDetail">>;

/**
 * The Health tab's workspace rows, by slot: every one with containers, and one with none that waits
 * on the person (a stage gate usually waits with nothing up), so its needs show as in the pane (SW-971).
 */
export function healthRows(
  features: WorkspaceStatus[],
  prs: PrExtra,
): { f: WorkspaceStatus; d: WorkspaceDisplay }[] {
  return features
    .map((f) => ({ f, d: displayModel(f, prs[f.name]) }))
    .filter(({ f, d }) => f.total > 0 || d.needsList.length > 0)
    .sort((a, b) => (a.f.slot ?? 99) - (b.f.slot ?? 99));
}
