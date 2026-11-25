/** The dashboard's tabs, in order, with their labels; the URL hash names one. */
export const TABS = [
  ["list", "Workspaces"],
  ["new", "New workspace"],
  ["prs", "Open Pull Requests"],
  ["health", "Health"],
  ["flow", "Flow"],
  ["metrics", "Metrics"],
  ["links", "Links"],
] as const;
export type Tab = (typeof TABS)[number][0];
export const isTab = (h: string): h is Tab => TABS.some(([t]) => t === h);

/** The URL hash (without `#`) as a tab, plus the workspace of `flow/<workspace>` (SW-1099). */
export function parseHash(h: string): { tab: Tab; workspace: string | null } {
  const [head = "", ...rest] = h.split("/");
  if (head === "flow" && rest.length) {
    try {
      return { tab: "flow", workspace: decodeURIComponent(rest.join("/")) || null };
    } catch {
      return { tab: "flow", workspace: null };
    }
  }
  return { tab: isTab(h) ? h : "list", workspace: null };
}
