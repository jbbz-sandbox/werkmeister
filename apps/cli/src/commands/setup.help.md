## Description

The guided first run (and re-run) of a werkmeister machine. It asks everything up front, then walks through each prerequisite that lives outside the checkout: paths, browser, ingress, the service registry, the issue tracker, and optional tools (telepresence, the superpowers plugin, editor settings). It writes the machine-global config in `~/.werkmeister` and converges the rest.

## Examples

```bash
werkmeister machine setup           # guided
werkmeister machine setup --check   # report state, change nothing
werkmeister machine setup --yes     # accept every default
```
