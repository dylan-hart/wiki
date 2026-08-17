# Variances

Genuine, justified deviations from spec. An entry is removed once resolved — this file is not a
changelog.

## Git storage `sync` always runs two-way; no `push`/`pull`-only mode yet (task 507, feature 372)

Task 507 ("sync action: bidirectional pull-rebase, push, and remote-change import") specifies:
"Read whatever sync-direction config Feature 370 introduces (push-only/pull-only/two-way) and skip
the irrelevant half of the sequence accordingly." Feature 370 ("Content Dispatch & Sync Engine") is
the feature that lands that config — a `sync.mode` field on `StorageTarget`, backed by a real
`storage` table column — but its work exists only on the sibling `feature/content-dispatch-sync-engine`
branch, not on `feature/git-storage-target` (confirmed directly: this branch's `StorageTarget`
interface and `git/definition.yml` have no sync-mode concept at all — `definition.yml` says so in its
own comment). Per this repo's branch-isolation rule, `feature/git-storage-target` may not merge,
cherry-pick, or otherwise copy that config from the sibling branch; and no coordination channel to
that feature's own work was reachable when this task ran.

`backend/modules/storage/git/sync.ts`'s `sync()` therefore always runs the full two-way sequence —
pull-rebase, push, then reverse-import the pull's changes — unconditionally. This matches 2.5.x's own
`mode: 'sync'` behavior (verified directly against `server/modules/storage/git/storage.js`), and is
the only mode this fork's `git/definition.yml` exposes today: its `sync` action has no mode selector
of its own to read.

Resolution: once Feature 370 lands `StorageTarget.sync.mode` on this branch, wrap the pull half and
the push half of `sync()` each behind a mode check — mirroring 2.5.x's own
`if (_.includes(['sync', 'pull'], mode))` / `if (_.includes(['sync', 'push'], mode))` guards — so a
`push`-only or `pull`-only target skips the irrelevant half instead of always doing both.
