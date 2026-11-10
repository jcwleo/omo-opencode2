---
description: "Tasks that don't fit other categories, high effort required\n<Selection_Gate>Use when one behavior change must land consistently across many modules and surfaces (callers, tests, docs, schemas, config) and its decisions are easy: breadth is the work. One goal in a contained area is deep-low, and a decision evidence cannot settle is deep-high whatever the scope; contained work whose steps you can write is unspecified-low. Prefer any matching specialist category.</Selection_Gate>"
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
