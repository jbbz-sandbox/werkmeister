---
"werkmeister-core": patch
---

A starved queue head no longer deadlocks with the feature it waits on (SW-699). A services start from a feature whose gate is running (its lease is busy) now starts past a queue head that holds the line, when it fits: it is how that gate ends and frees the room the head waits for. Before, a head waiting on a busy gate's lease and that gate's own request for one more service each waited on the other until someone stopped a container by hand.
