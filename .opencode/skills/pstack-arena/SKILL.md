---
name: pstack-arena
description: Compare multiple complete solutions to the same non-trivial artifact, select a base, and integrate only proven improvements. Use ONLY through /arena or explicit poteto-mode routing.
license: MIT
compatibility: opencode
---

# Arena

1. Define one artifact and a concrete rubric.
2. Give every candidate identical grounding and separate output paths. Use separate worktrees for code.
3. Launch two or three `poteto-agent` candidates in parallel.
4. After candidates finish, ask `pstack-reviewer` to score them while the parent reads every artifact.
5. Select the simplest extensible base. Record why each alternative lost.
6. Integrate useful ideas by redesigning them into the base, not by pasting unrelated implementations together.
7. Verify the synthesized result against the original rubric.

If candidates diverge because the task was underspecified, tighten the framing and rerun. Never let candidates write to shared mutable state.
