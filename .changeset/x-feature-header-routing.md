---
"werkmeister": patch
---

Caddy now routes a local host by the `X-Feature` request header as well as the `X-Feature` cookie, as `werkmeister-context.md` says. Before, a request with only the header (`curl -H "X-Feature: <feature>"`) reached another workspace's container. When the header and the cookie name different features, the header wins. Run `werkmeister infra proxy-reload` after upgrading to apply it.
