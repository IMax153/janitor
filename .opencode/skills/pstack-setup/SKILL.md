---
name: pstack-setup
description: Configure project-local pstack agent models from models available to OpenCode. Use ONLY through /setup-pstack or an explicit request to configure pstack.
license: MIT
compatibility: opencode
---

# Setup pstack

1. Run `opencode models` and use only returned `provider/model-id` values.
2. Read `.opencode/agents/poteto-agent.md`, `pstack-explorer.md`, and `pstack-reviewer.md`.
3. Ask whether the user wants inherited models or explicit worker, explorer, and reviewer choices.
4. For explicit choices, add or replace only the `model` field in pstack-owned agent frontmatter. Never rewrite unrelated config or agent instructions.
5. Run `vp run check:pstack`.
6. Tell the user to restart OpenCode because agents and skills load at startup.

Omitting `model` inherits the invoking primary agent's model. Do not translate Cursor model aliases or guess provider IDs.
