---
"werkmeister": patch
---

`overrides.telepresence: false` in `~/.werkmeister/config.yaml` keeps werkmeister from starting `telepresence` on its own (SW-920). The `/workspaces` pane, `feature status` and the `intercepts` tool show no intercepts, `feature down` leaves none, and `werkmeister infra intercept` fails with `TELEPRESENCE_DISABLED`. `infra intercept --leave` still runs, to remove an intercept left from before. Unset or `true` keeps today's behaviour.
