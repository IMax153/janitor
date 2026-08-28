---
name: pstack-interrogate
description: Run independent adversarial review over a design, diff, or pull request and synthesize actionable findings. Use ONLY through /interrogate or explicit poteto-mode routing.
license: MIT
compatibility: opencode
---

# Interrogate

1. Define the artifact, intended behavior, and review base.
2. Launch two or three `pstack-reviewer` tasks in parallel with distinct lenses such as correctness, security and boundaries, and maintainability and tests.
3. Require exact references and a concrete failure scenario for every finding.
4. Reproduce or inspect each claim. Reject duplicates, style-only churn, and unsupported speculation.
5. Report accepted findings by severity, followed by open questions and residual testing gaps.

Do not modify the artifact unless the user explicitly asks for fixes.
