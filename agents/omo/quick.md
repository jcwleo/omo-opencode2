---
description: "Trivial tasks - single file changes, typo fixes, simple modifications\n<Caller_Warning>Small/fast model: before delegating, write an explicit prompt with numbered must-do steps, forbidden deviations, and concrete success criteria.</Caller_Warning>"
mode: subagent
permissions:
  - action: "subagent"
    resource: "*"
    effect: deny
  - action: "question"
    resource: "*"
    effect: deny
---
