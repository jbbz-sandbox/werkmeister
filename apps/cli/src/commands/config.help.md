## Description

Sets up and maintains the machine-global configuration, `~/.werkmeister/config.yaml`, the single source of truth. Writing it also regenerates `~/.werkmeister/env.sh` and keeps a managed block in `~/.zshenv` that sources it. The `WERKMEISTER_*` environment variables are derived from the YAML, not read as input.

## Examples

```bash
werkmeister machine config                       # print the resolved config and origins
werkmeister machine config --write               # interactive wizard, then write
werkmeister machine config --check               # validate; nonzero exit on drift
```
