# pstack for OpenCode

This project contains a focused OpenCode port of Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack), based on upstream commit `397c8660da6d3d873a91e18c2ca2f22cac1f0ac1`.

## Use

Restart OpenCode after installing or changing these files. Select the `poteto` primary agent for sticky pstack behavior, or run `/poteto-mode <task>` for one task.

Direct commands are available for `/how`, `/why`, `/architect`, `/arena`, `/swarm`, `/interrogate`, `/tdd`, `/no-comments`, `/unslop`, and `/setup-pstack`.

Agents inherit the current model by default. `/setup-pstack` can assign available `provider/model-id` values to pstack-owned agents.

## Scope

This test port keeps pstack's core design, delegation, review, and verification workflows. The original 21 principle skills are condensed into `poteto-mode` so OpenCode advertises fewer internal skills.

The port does not emulate Cursor cloud agents, sticky skill metadata, `/loop`, Bugbot, Cursor transcript paths, Cursor Automations, Grok Bot routines, or unattended merging. OpenCode subagents run locally. Long-running external automation would need a separate scheduler using `opencode run`, the SDK, or the server API.

The dormant Benny automation pack is not included because its Slack event runtime and capability isolation need an implementation outside the skill system.

## Permissions

Read-only research and review agents deny edits. Implementation agents cannot push, merge, deploy, clean worktrees, or communicate externally by instruction. The primary workflow requires explicit approval for those actions.

Run `vp run check:pstack` to validate names, frontmatter, command wrappers, required agents, OpenCode config, and the absence of active Cursor-specific instructions.

## License

The adapted pstack material remains available under the MIT License. See `LICENSE`.
