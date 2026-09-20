# Comment recommendations: git storage self-heal (WP 3567)

No code comments were added or changed in this work. These are the ones that should follow.

## `backend/modules/storage/git/sync.ts`

- `sync()` doc comment, first sentence ("A rebase conflict is deliberately not caught: it aborts the
  sync and leaves the working copy mid-rebase for an administrator") is now half true. The conflict
  still leaves the working copy mid-rebase, but the next pulling sync aborts that rebase (via
  `ensureRepo`'s `abortInterrupted` option) before retrying. Suggested:
  "A rebase conflict is deliberately not caught: it fails the sync and leaves the working copy
  mid-rebase so an administrator can inspect it. The next pulling sync rolls that rebase back
  (`abortInterrupted`) and retries."
- `reattach`: add a why, e.g. "`git.merge`, not `raw(['merge'])`: simple-git only throws on a
  conflicted merge when it parses the summary, and a raw merge conflict exits non-zero with an empty
  stderr, which it does not treat as an error. No `-X` strategy on purpose: a conflict here fails loud
  rather than choosing a side."
- `sharesHistoryWith`: "`merge-base` exits non-zero when there is no common commit, which simple-git
  raises."
- The `if (reattached) return` before the diff import: "Every file on the remote just arrived, so the
  diff is the whole repository; importing it would rewrite every page from a copy of itself."

## `backend/modules/storage/git/repo.ts`

- `abortInterruptedRebase`: "Runs inside `ensureRepo`, before `ensureBranch`: `git checkout` refuses to
  move a branch while the index is unmerged, so a stale rebase would fail `ensureRepo` itself before a
  later step could clean it up."
- `EnsureRepoOptions.abortInterrupted`: opt-in so a content-commit caller never rolls back a rebase an
  administrator is in the middle of.

## `backend/modules/storage/git/actions.ts`

- `purge` doc comment says "`ensureRepo` never fetches or clones, it only inits" and "no effect
  whatsoever on the remote". Purge now pulls the configured branch after re-initializing (still no
  push, commit or remote change). Suggested: "Never writes to the remote. With a `repoUrl` configured
  it re-clones the branch after re-initializing, via `ensureRepo` so auth and ssh config are shared
  with sync."
- Add at the `listRemote` check: "`ls-remote` first so a brand-new empty remote purges to an empty
  repo instead of failing on a branch that does not exist yet."
