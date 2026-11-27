---
"werkmeister": patch
---

SW-1060: creating a grouped workspace (`group:`) now reads each member ticket. The issue extractor gets them beside the lead, with the rule that the grouped PR covers every one, and the starting prompt (and so `BRIEF.md`) gets a `### <KEY>` acceptance-criteria subsection per member, taken from that member's ticket. A non-goal line that names a member is dropped. A member that can't be read is named in a warning and left out.
