/**
 * ANSI colour/style constants for the developer sandbox CLI.
 *
 * The single ANSI definition site -- import from here rather than
 * re-declaring RED/BOLD/RESET locally.
 */

export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

/** Grouped form (`Colors.RED`, ...). */
export const Colors = { RED, GREEN, YELLOW, CYAN, BOLD, DIM, RESET } as const;
