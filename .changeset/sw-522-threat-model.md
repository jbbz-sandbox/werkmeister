---
"werkmeister": patch
---

SW-522: the threat model for pre-approved test and CLI rules is written down in `docs/context-strategies.md` and in the generated `werkmeister-context.md`: registered test commands and the workspace's own built CLI may run agent-written code with the real HOME, env, network, docker and gh; the temp HOME is not a sandbox. A test holds the generated rules to it.
