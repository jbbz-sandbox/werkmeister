// Moved: the merge now lives with the claudeck plugin that runs it automatically
// (apps/claudeck/plugins/sandbox-workspace/), so the server and this on-demand
// script share one implementation. This file is a shim; delete it together with
// scripts/sync-workspaces-to-claudeck.mjs.
export { mergeFolders } from "../../apps/claudeck/plugins/sandbox-workspace/merge-folders.mjs";
