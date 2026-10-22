---
"werkmeister": minor
---

The plugin's skills no longer need Python. `sandbox starting-prompt` prints the enclosing workspace's `starting_prompt` (exit 1: no `workspace.yml` found, 2: none set; `--start <dir>` to search from elsewhere) and replaces the starting-prompt skill's `get_prompt.py`. `sandbox test <feature> --scaffold` writes `playwright.config.ts` and `<feature>.spec.ts` into the workspace if missing and installs the pinned `@playwright/test`, replacing the feature-test skill's `setup_feature.py`; `--workspace` and `--base-url` carry over. Both reuse the CLI's own config, ingress and slot lookups, so the Playwright version and ingress host no longer have a second copy to keep in step.
