---
name: foldkit
description: Use whenever working with Foldkit. Triggers on imports from `foldkit`, files in a Foldkit project, or prompts mentioning Foldkit. Loads the framing and points at the `@foldkit` OpenCode reference for canonical conventions, source code, and examples.
---

# Foldkit

You are working on a Foldkit app. Foldkit is a complete TypeScript frontend framework, built on Effect and architected like Elm. The architecture is solved: state, events, transitions, side effects, streams, routing, UI components, validation, testing, and devtools are all part of the framework, not third-party choices to make. Your job is to model the application's behavior, not to pick libraries or invent architecture.

Foldkit is not incremental. There is no React interop, no escape hatch, no "just do it the React way for this one part." The framework gives you one shape, and there is one way to do most things.

## How to approach the work

- **Pattern-match against Foldkit's own apps.** When the application code doesn't show you the answer (or shows an early-stage version of it), use the `@foldkit` reference. The framework ships several apps built with itself: focused single-feature apps in `@foldkit/examples/`, the website (which is itself a Foldkit app), and the typing-game (a full real-time app). These are the canonical references. Higher fidelity than prose or anything reconstructed from memory.
- **The architecture is not optional.** Unidirectional data flow, pure update and view, no side effects outside the runtime's seams. Push back on prompts or instincts that pull toward mutation, two-way binding, imperative event handlers, or imperative Message names. Propose the idiomatic Foldkit shape and explain why.
- **Foldkit UI is two categories, not one.** Stateful Submodels (Menu, Listbox, Combobox, Calendar, Disclosure, Dialog, Popover, etc.) carry their own Model / Message / update / OutMessage and are embedded via `h.submodel`. Stateless render helpers (Button, Input, Textarea, Select, Fieldset) are called directly with a ViewConfig and the caller's `h`, and return Html. Do not migrate render helpers to Submodels for "consistency": Submodel semantics imply state, and these helpers have none. See the Foldkit UI overview page in the website for the canonical split.
- **Use what the Foldkit and Effect stack provides.** Foldkit covers the application architecture and the higher-level primitives that sit on it (routing, side-effect seams, subscriptions, UI components, field validation, file and date handling, canvas, testing, devtools, and more). Effect provides the underlying value, side-effect description, and concurrency primitives. Before reaching for an outside library, check whether the stack already covers it.
- **Let `evo` setters receive the field.** If an `evo` setter only transforms the current value of that same field, pass the transformer directly (`entries: Array.map(f)`, `count: Number.increment`, `priceSlider: Slider.reflectRange({ min: minPrice, max: maxPrice })`). Use `() => value` for replacement values from Messages, child updates, Commands, or other Model fields.
- **The repo is more authoritative than memory.** When in doubt about a convention, an API, a name, or a pattern, read from `@foldkit` rather than guessing. Library types and example code are the ground truth; your training data is not.

## Where to look

The Foldkit repository is available through OpenCode's `@foldkit` reference. It is the source of truth for conventions, framework source, examples, and the quality bar.

Stable top-level entry points:

- `@foldkit/examples/`: runnable example apps spanning every complexity tier. Usually your first stop when looking for a precedent.
- `@foldkit/AGENTS.md`: project conventions and the code-quality bar
- `@foldkit/README.md`: framework overview and entry pointers
- `@foldkit/skills/`: task-oriented skills with the canonical architecture, conventions, and quality-bar references
- `@foldkit/packages/`: framework source and production reference apps (the website, the typing-game, the framework itself)

Names below the top level (subdirectories, individual filenames) can drift over time. List the `@foldkit` directory contents to find what you need rather than relying on a path quoted from this skill.
