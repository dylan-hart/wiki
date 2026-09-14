# Decision Record: The oxfmt 0.62.0 → 0.64.0 Incident

**Status:** Resolved — process fix is the checklist item in `CLAUDE.md`'s Style/linting/formatting
section
**Author:** task #1988

## What happened

Bumping `oxfmt` from `0.62.0` to `0.64.0` (`377915c6`) silently invalidated seven already-formatted
`frontend/` SFCs: a single leading space before a `<script setup>` JSDoc opener that 0.64 no longer
accepts as correctly formatted. The bump's own commit message claimed a full `oxfmt --check` run had
confirmed the tree was still clean — it hadn't actually been run against `frontend/`, only against
the workspace the bump was made from.

## Why it matters

A formatter/linter version bump is not a plain version-string edit. A newer release can change what
it considers correctly formatted, which means a version bump can invalidate files nobody touched —
and unlike a normal code change, nothing about the diff (just a `package.json` version bump) hints
that the rest of the tree needs re-checking.

## The fix

Bumping oxlint or oxfmt's version is now a dependency-bump checklist item, not a plain version-string
edit. Whenever either tool's version changes, run the **reformat** (not just the check) across all
three workspaces from the repo root in the same commit as the bump:

```sh
npx --prefix backend oxfmt backend frontend blocks   # reformats — not --check
npx oxlint                                            # from backend/, frontend/ and blocks/ each
```

Then confirm `npx --prefix backend oxfmt --check backend frontend blocks` exits clean before pushing.
Skipping this step is exactly how a version bump ships a red CI gate with nothing wrong in the code
itself.
