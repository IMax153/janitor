---
name: pstack-tdd
description: Fix a defect with a cheap deterministic local test by proving the failure before changing production code. Use ONLY through /tdd or poteto-mode bug-fix routing.
license: MIT
compatibility: opencode
---

# TDD

Use this workflow when a focused test can reproduce the defect without expensive or flaky setup.

1. State the incorrect behavior and expected behavior.
2. Add the smallest semantic test that fails for the right reason.
3. Run only that test and capture the failure.
4. Make the smallest root-cause fix.
5. Run the focused test, then the nearest relevant suite.
6. Refactor only if it reduces reader load without weakening the proof.

If no useful local test boundary exists, reproduce through the real surface and explain why test-first is not economical.
