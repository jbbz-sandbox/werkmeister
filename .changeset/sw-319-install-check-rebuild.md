---
"werkmeister": patch
---

SW-319: the plugin's install check (`skills/install-check/check.sh --fix`) brings a stale `dist` up to date after a `main` pull. It runs `corepack pnpm install --frozen-lockfile`, then `corepack pnpm turbo run build --filter=werkmeister`, so core is rebuilt before the CLI bundles it. It prints `FIX` only when the rebuild succeeds; a failed rebuild prints the first error lines and no longer refuses the next prompt of every session.
