## Description

Compares running containers' actual usage with their configured limits, shows which services are over- or under-provisioned, and recommends changes.

## Examples

```bash
werkmeister optimize              # analyze current usage against the limits
werkmeister optimize --collect 5  # collect for 5 minutes first, then analyze
```
