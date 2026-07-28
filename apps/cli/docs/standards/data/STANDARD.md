---
domain: data
applies_to:
  - "**/dags/**"
  - "**/pipelines/**"
  - "**/*.py"
phase: [implement, review]
task_signatures:
  - "airflow"
  - "dag"
  - "epoch"
summary: Data standard — Airflow ordering/scheduling requirements, epoch-ms conventions.
---

# Data standard

> Placeholder module — extend as data-engineering review nits accumulate (see the
> living-document rule in [../code-style-guide.md](../code-style-guide.md)).

The shared comment rubric ([comments.md](comments.md)) applies in full. Below are the
data-specific cases where a comment is earned.

## What justifies a comment

- **Ordering/scheduling requirements** — Airflow task dependencies, retry semantics, and
  timing constraints the DAG structure alone can't show.
- **External-system quirks** — Airflow, Typesense, and source-DB behaviors.
- **Unit conventions** — e.g. epoch-ms storage decisions and their sentinel values.

Keep docstrings that add value; drop ones that echo the signature.

## Idioms

```python
# Stored as epoch ms (0 when absent) so range filters never hit a missing-field
# error across the non-published statuses. (TRE-2022)
indexed_at = to_epoch_ms(doc.get("updated_at")) or 0
```
