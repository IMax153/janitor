---
name: pstack-no-comments
description: Review changed comments and suppressions before handoff, deleting narration and replacing project-owned surprises with clearer code. Use ONLY through /no-comments or poteto-mode routing.
license: MIT
compatibility: opencode
---

# No comments

1. Give `comment-sicko` the exact changed files or diff.
2. Check every recommendation against nearby code and external constraints.
3. Delete narration, banners, commented-out code, and stale explanations.
4. Replace project-owned surprises with names, types, boundaries, or tests when the change remains in scope.
5. Keep legal headers, public API contracts, formatter directives, issue links, and proven external constraints.
6. Run the smallest relevant check after accepted edits.

Do not remove a comment merely to satisfy a count. The goal is code that explains itself without losing facts it cannot encode.
