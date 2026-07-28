---
domain: observability
applies_to:
  - "**/instrumentation/**"
  - "**/telemetry/**"
  - "**/*.otel.*"
  - "**/logging/**"
  - "**/*.logger.ts"
phase: [implement, review]
task_signatures:
  - "opentelemetry"
  - "telemetry"
  - "instrumentation"
  - "structured logging"
  - "correlation id"
  - "correlation-id"
  - "distributed trace"
  - "tracing"
summary: Telemetry — OTel span/attribute conventions, structured logging, trace/correlation-ID propagation across service hops.
---

# Observability standard

Telemetry conventions where instrumentation and logging are defined. (Spans and
logs appear anywhere in business logic; this standard's glob covers the
instrumentation/logging surface, where the conventions bite hardest.) The shared
comment rubric ([comments.md](comments.md)) applies in full.

## Rules

- **Propagate trace context across every hop** — an outbound call forwards trace
  context so a request is one trace end-to-end, not orphaned spans.
- **Log structured, not string-interpolated** — key/value fields, never a
  formatted sentence that can't be queried.

## Don't

- Don't emit a log as a pre-formatted sentence with values baked into the string
  — attach them as structured fields instead.
