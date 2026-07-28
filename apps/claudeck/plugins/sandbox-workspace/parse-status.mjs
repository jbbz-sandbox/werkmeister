// Pure: parse `git status --porcelain=v1` into staged / changes / untracked
// groups. Ported verbatim from claudeck's core git-panel so per-worktree status
// matches the Git tab exactly. No IO.

function parseStatusCode(x, y) {
  if (x === "?" && y === "?") return { group: "untracked", badge: "?", cls: "untracked" };
  if (x === "A") return { group: "staged", badge: "A", cls: "added" };
  if (x === "M") return { group: "staged", badge: "M", cls: "modified" };
  if (x === "D") return { group: "staged", badge: "D", cls: "deleted" };
  if (x === "R") return { group: "staged", badge: "R", cls: "renamed" };
  if (y === "M") return { group: "changes", badge: "M", cls: "modified" };
  if (y === "D") return { group: "changes", badge: "D", cls: "deleted" };
  return { group: "changes", badge: x || y, cls: "modified" };
}

export function parsePorcelain(stdout) {
  const lines = String(stdout || "").split("\n").filter(Boolean);
  const groups = { staged: [], changes: [], untracked: [] };

  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    const info = parseStatusCode(x, y);
    groups[info.group].push({ file, badge: info.badge, cls: info.cls });

    // A file staged AND further modified in the working tree appears in both.
    if (x !== " " && x !== "?" && y !== " " && y !== "?") {
      groups.changes.push({ file, badge: y === "M" ? "M" : y, cls: y === "D" ? "deleted" : "modified" });
    }
  }

  return groups;
}
