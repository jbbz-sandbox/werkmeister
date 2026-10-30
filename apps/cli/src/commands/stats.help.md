## Description

Shows Docker resource usage for every werkmeister container: one snapshot by default, or samples collected over a period.

## Examples

```bash
werkmeister stats                     # snapshot of current usage
werkmeister stats --collect 5         # collect for 5 minutes
werkmeister stats --collect 30 -i 5   # 30 minutes, 5-second intervals
```

## See also

`werkmeister optimize` compares the same numbers with the configured limits.
