---
"werkmeister": patch
"werkmeister-core": patch
---

Capacity queue (SW-729): a queued whole-feature head that would fit no longer holds every start behind it. Only another feature stopping starts that head, and room can free without one (a timed-out gate's stop, a Docker restart), so on an idle host starts waited 10 minutes and exited 75 again and again. The exit-75 message now says how long the head has really waited, the same figure `budget status` shows, instead of always "5 min".
