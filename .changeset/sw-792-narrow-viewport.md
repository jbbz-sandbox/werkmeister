---
"werkmeister": patch
"werkmeister-core": patch
---

The implement stage contracts say the Chrome window does not size below 477 px, and check a narrower width (e.g. 375 px) in a same-origin iframe built with the JS tool: a screenshot plus `scrollWidth === clientWidth` inside the frame.
