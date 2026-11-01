/** Claude Desktop specifics outside the Claude Code CLI (SW-187). */

/**
 * Claude Desktop's end-of-turn box: its `ask` is the run's question, and the
 * closing message after it is told not to repeat it.
 */
export const WRAP_UP = "mcp__ccd_turn__wrap_up";

/** PR rule 5's warning off Desktop's own Auto-fix, which `werkmeister pr watch` replaces (SW-160). */
export const DESKTOP_AUTOFIX_RULE = "Don't turn on Auto-fix in the Claude desktop app (`ccd_pr`).";
