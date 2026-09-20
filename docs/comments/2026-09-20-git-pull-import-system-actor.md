# Recommended comment changes: WP #3569 (git pull-import system actor)

Not applied, per the no-self-edited-comments rule.

## `backend/modules/storage/git/sync.ts`, doc comment above `resolveImportActor`

Now stale: it says there is "no fixed system user to fall back on" and that the import "is skipped
rather than fabricated". Replace with:

```ts
/**
 * A bare `git diffSummary` carries no per-file author (only per-commit, and a commit can touch many
 * files), so a pulled change is attributed to whoever is registered under the target's Default
 * Author Email, the same identity `content.ts`'s `resolveAuthor` commits *out* to git under. With
 * no such user it falls back to the reserved system user (`users.ensureSystemUser()`) rather than
 * skipping the import.
 */
```

## `backend/modules/storage/git/definition.yml`, `defaultEmail.hint`

"Used as fallback in case the author of the change is not present." could add that an import with
no matching user is attributed to the system account. Only if the hint is meant to describe pull
attribution; it currently reads as the commit-out fallback.
