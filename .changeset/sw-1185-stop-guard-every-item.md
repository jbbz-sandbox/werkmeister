---
"werkmeister": patch
---

SW-1185: the werkmeister plugin's Stop guard now blocks while any stage output still has a `status: proposed` line, not only until one AskUserQuestion is answered. One answered batch of 4 no longer lets the rest of the proposed items go unasked. After a block, it blocks again while the count keeps falling. A stop with as many items left as at the last block counts as a gate the person deferred, and goes through. It no longer reads the session transcript.
