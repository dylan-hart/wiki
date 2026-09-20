# Git pull-import is attributed to a reserved system user, not skipped

**Date:** 2026-09-20
**OpenProject:** #3569; source: `docs/audits/2026-09-17-upstream-scarlett-fold-in-audit.md` §3 Tier 3 #40

## Decision

A pull-import (`sync()`) and a full import (`importAll`) in `backend/modules/storage/git/` always
have an actor. `resolveImportActor` still prefers the user registered under the target's Default
Author Email, but when that is unset or matches nobody it falls back to a reserved **system user**
instead of returning `null` and skipping the whole DB import.

The system user is a real `users` row, at the fixed id `systemIds.systemUserId` in `base.yml`, with
`isSystem: true`, `isActive: false`, an empty `auth` object (no strategy, so nothing can sign in as
it) and the reserved address `system@cardinal.invalid`. `users.ensureSystemUser()` creates it
idempotently (`insert ... on conflict (id) do nothing`) and is called lazily from
`resolveImportActor`, so an existing database needs no migration and no seeding step. The actor's
`manage:system` permission is synthesized exactly as before.

## Why a row, not a synthetic id

`pages.authorId`, `pages.creatorId`, `pages.ownerId` and `assets.authorId` are `NOT NULL` foreign
keys to `users.id`, and `pageHistory.authorId` is a foreign key too. An id with no row behind it
would be rejected by the database on the first imported page. The guest account is the existing
precedent for an `isSystem` row.

## Why not an admin user

Rejected in the work package: arbitrary, misattributes edits to a real person, and can point at a
deleted or disabled account.

## Consequences

- The system user shows as the author of pulled changes that could not be matched to a user. It is
  excluded from the places that already exclude `isSystem` accounts, and `reassignContent` already
  refuses a system user as a target.
- Skipping was the old behaviour for an unmatched email; nothing now logs that warning.
