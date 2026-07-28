---
repo: data-engineering
summary: Ordering/scheduling requirements and external-system quirks (Airflow, Typesense, source DBs).
---

# data-engineering — repo notes

Watch for **ordering/scheduling requirements** and external-system quirks (Airflow,
Typesense, source DBs). Keep docstrings that add value; drop ones that echo the signature.

```python
# Stored as epoch ms (0 when absent) so range filters never hit a missing-field
# error across the non-published statuses. (TRE-2022)
indexed_at = to_epoch_ms(doc.get("updated_at")) or 0
```
