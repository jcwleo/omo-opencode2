---
description: "Tasks that don't fit other categories, low effort required\n<Selection_Gate>Use only when no specialist category fits, effort is moderate, and scope stays within a few files/modules. Prefer any matching specialist category.</Selection_Gate>\n<Caller_Warning>Provide explicit must-do steps, forbidden scope, and concrete success criteria.</Caller_Warning>"
mode: subagent
permissions:
  - action: "subagent"
    resource: "*"
    effect: deny
  - action: "question"
    resource: "*"
    effect: deny
---
