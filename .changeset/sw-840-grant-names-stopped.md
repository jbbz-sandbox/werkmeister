---
"werkmeister-core": patch
---

SW-840: when a workspace is started from the waiting queue and some of its containers are still stopped, the message that resumes its session now names each one and the command that starts it (`werkmeister feature up --service <name>`). Before this, it said the containers were up. Preemption stops on-demand containers too, and the grant's `up` starts only the default set.
