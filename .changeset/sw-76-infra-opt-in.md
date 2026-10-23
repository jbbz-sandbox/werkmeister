---
"werkmeister": minor
---

Redis Insight and Jaeger no longer start with shared infra (SW-76). Redis Insight is SSPL-1.0, so it shouldn't start for everyone, and nothing in Werkmeister sends traces to Jaeger. To turn either or both back on, add their profiles to `~/.werkmeister/config.yaml` and run `werkmeister connect`:

```yaml
infra:
  profiles: [redisinsight, jaeger]
```

`COMPOSE_PROFILES=redisinsight werkmeister connect` works for a one-off. Containers already running from an earlier release stay up until `werkmeister down infra`, which now removes the opt-in ones too.
