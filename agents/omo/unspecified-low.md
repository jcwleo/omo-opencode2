---
description: "Tasks that don't fit other categories, low effort required\n<Selection_Gate>Use when you can already write the steps, the work stays within a few files or modules, and each step needs judgment (a logic-preserving refactor, a contained cross-file API change). Mechanical steps are quick; a goal you can state only as an outcome is deep-low. Prefer any matching specialist category.</Selection_Gate>\n<Caller_Warning>Provide explicit must-do steps, forbidden scope, and concrete success criteria.</Caller_Warning>"
mode: subagent
permissions:
  - action: "subagent"
    resource: "*"
    effect: deny
  - action: "subagent"
    resource: "omo/explore"
    effect: allow
  - action: "subagent"
    resource: "omo/librarian"
    effect: allow
  - action: "question"
    resource: "*"
    effect: deny
---
