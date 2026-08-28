---
name: poteto-mode
description: Route non-trivial engineering work through pstack's minimal design, delegation, review, and verification workflows. Use for /poteto-mode or when the poteto agent handles substantial work.
license: MIT
compatibility: opencode
metadata:
  source: cursor/plugins/pstack@397c866
---

# Poteto mode

## Start

For work with three or more distinct steps, open a todo list. Inspect the repository before choosing an approach. Match the task to the smallest workflow below and load only those skills.

| Need                                   | Skill                |
| -------------------------------------- | -------------------- |
| Understand implementation              | `pstack-how`         |
| Recover design rationale               | `pstack-why`         |
| Settle a cross-boundary design         | `pstack-architect`   |
| Compare complete alternatives          | `pstack-arena`       |
| Partition independent research or work | `pstack-swarm`       |
| Adversarially review an artifact       | `pstack-interrogate` |
| Fix a bug with a cheap local test      | `pstack-tdd`         |
| Review comments before handoff         | `pstack-no-comments` |
| Clean user-facing prose                | `pstack-unslop`      |

## Principles

- Prefer deletion and the smallest change that solves the stated problem.
- Name the data shape before writing stateful or branching logic.
- Parse external data at boundaries and keep internal states explicit.
- Make illegal states unrepresentable where the language permits it.
- Remove sharing before adding locks or serialized coordination.
- Reproduce defects and fix root causes rather than masking symptoms.
- Separate parallel writers by file, worktree, branch, or artifact.
- Break long work into independently verifiable units.
- Keep large searches and verbose evidence in subagents; retain summaries in the parent.
- Encode repeated lessons in tests, types, lint rules, or scripts instead of more prose.
- Verify the real artifact. Compilation alone does not prove behavior.

## Execution

Proceed autonomously on low-risk, reversible repository work. Ask only for product preferences or actions that are irreversible, shared, externally visible, privileged, or costly. Never assume permission to push, merge, deploy, delete data, clean worktrees, or send external messages.

Use `pstack-explorer` for read-only research, `pstack-reviewer` for independent judgment, and `poteto-agent` for bounded implementation. Parallelize independent tasks in one tool call. Review every delegate's evidence and diff yourself.

Open a pull request only when explicitly requested. OpenCode has no native Cursor cloud-worker or `/loop` equivalent, so do not promise unattended work that survives the current session.

## Handoff

State the outcome, changed paths, and verification run. Name unresolved risks or checks that could not run. Keep prose direct and load `pstack-unslop` when the response or artifact needs a writing pass.
