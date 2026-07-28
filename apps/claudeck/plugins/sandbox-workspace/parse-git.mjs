// Pure parser for `git status --porcelain=v1 -b` output. No IO.
// First line is the branch header: `## <branch>[...<upstream>] [ahead N, behind M]`
// (or `## HEAD (no branch)` when detached). Remaining non-empty lines are
// changed files. Returns branch, upstream, dirty count, ahead/behind.

export function parseGitStatus(stdout) {
  const lines = String(stdout || "").split("\n").filter((l) => l.length > 0);
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      let head = line.slice(3);

      // Split off the `[ahead N, behind M]` tracking suffix, if present.
      const tb = head.indexOf(" [");
      if (tb !== -1 && head.endsWith("]")) {
        const track = head.slice(tb + 2, -1);
        head = head.slice(0, tb);
        ahead = Number(/ahead (\d+)/.exec(track)?.[1] || 0);
        behind = Number(/behind (\d+)/.exec(track)?.[1] || 0);
      }

      const dots = head.indexOf("...");
      if (dots !== -1) {
        branch = head.slice(0, dots);
        upstream = head.slice(dots + 3);
      } else {
        branch = head;
      }
      if (branch === "HEAD (no branch)") branch = null;
    } else {
      dirty += 1;
    }
  }

  return { branch, upstream, dirty, ahead, behind };
}
