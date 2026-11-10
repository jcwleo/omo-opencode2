---
description: "Default deep lane: one goal, one deliverable, decisions the child can settle from what it reads; preferred over deep-high for 3D graphics, computer/browser use, CAPTCHA, multimodal, backend, logic, and algorithm work. Multiple goals fan out as parallel calls.\n<Selection_Gate>Route by the shape of the work, not its size. This is the default lane for one goal stated as an outcome (fix this, build that) whose decisions the child can settle from code, tests, and history, even when the change touches several files. Steps you can already write out go to unspecified-low (each step needs judgment) or quick (mechanical); one behavior change that must land consistently across many modules, tests, docs, and config goes to unspecified-high. Between the deep lanes, when unsure, choose deep-low; a misrouted child returns `ESCALATE: deep-high` after one cheap attempt, and you re-spawn the same brief as deep-high with its findings.</Selection_Gate>"
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
