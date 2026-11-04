---
"werkmeister-core": patch
---

SW-237: `werkmeister machine setup` leaves the werkmeister plugin alone when `CLAUDE_CODE_PLUGIN_DIRS` (the shell's, or `env` in `~/.claude/settings.json`) already loads it from a checkout: no marketplace add or install, reported as `loaded from <dir> (dev mode)`. `--check` no longer reports such a machine as missing the plugin, and flags a marketplace copy that overrides the checkout, with the uninstall commands.
