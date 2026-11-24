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
