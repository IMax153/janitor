---
name: pstack-how
description: Explain how a subsystem works from source and runtime evidence. Use ONLY through /how, an explicit how request, or poteto-mode routing.
license: MIT
compatibility: opencode
---

# How

1. Restate the target and identify its entry points, data shapes, and observable behavior.
2. Launch independent `pstack-explorer` tasks for distinct layers when parallel research will reduce uncertainty.
3. Trace one representative flow end to end. Include callers, transformations, state ownership, side effects, and failure paths.
4. Reconcile explorer reports against source. Resolve contradictions by reading or running the code.
5. Explain the system in execution order. Cite paths and line numbers. Separate observed facts from inference.

Do not modify code unless the user also requested a change.
