---
name: pstack-swarm
description: Partition independent research or implementation across parallel agents and aggregate one checked result. Use ONLY through /swarm or explicit poteto-mode routing.
license: MIT
compatibility: opencode
---

# Swarm

1. Define the coverage matrix, completion condition, and output format.
2. Split work into non-overlapping partitions. Use `pstack-explorer` for research and `poteto-agent` for implementation.
3. Give writers separate files, worktrees, or branches.
4. Launch independent partitions together.
5. Check every report against its assigned scope. Retry only missing or failed partitions.
6. Deduplicate findings and return one aggregate result with coverage gaps and verification.

Use `pstack-arena` instead when workers are competing on the same artifact.
