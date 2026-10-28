---
description: "Use ONLY for genuinely hard, logic-heavy tasks. Give clear goals only, not step-by-step instructions."
mode: subagent
permissions:
  - action: "subagent"
    resource: "*"
    effect: deny
  - action: "question"
    resource: "*"
    effect: deny
---
