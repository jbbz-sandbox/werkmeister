---
"werkmeister": patch
---

Minify the published CLI bundle (`minify: true`, `keepNames: true`) so the package is smaller and loads faster. Function and class names stay in stack traces, third-party license notices stay in the bundle, and `.map` files stay out of the package (SW-58).
