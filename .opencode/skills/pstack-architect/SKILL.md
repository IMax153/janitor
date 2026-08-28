---
name: pstack-architect
description: Settle a non-trivial cross-boundary design before implementation. Use ONLY through /architect or when poteto-mode finds a genuine architectural fork.
license: MIT
compatibility: opencode
---

# Architect

1. Load `pstack-how` and ground the current behavior, callers, types, and constraints.
2. Write a task-specific rubric with three to six observable criteria.
3. Ask two or three `pstack-reviewer` agents for independent designs. Give each the same facts and rubric.
4. Compare the designs criterion by criterion. Prefer fewer concepts, explicit ownership, narrow boundaries, and states the type system can enforce.
5. Produce one decision with data shapes, API boundaries, rejected alternatives, risks, and a verification strategy.
6. Implement only if requested. If implementation reveals a false premise, stop and update the design rather than preserving it through compatibility code.

Skip this workflow for a local edit with no meaningful design choice.
