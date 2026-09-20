# Group names are unique ignoring case and surrounding whitespace

**Date:** 2026-09-20
**OpenProject:** #3552

## Decision

`groups` carries a unique index, `groups_name_normalized_idx`, on `lower(trim(name))`. It lives in
the flat base migration (no separate migration file: there are no production instances to upgrade).

`syncProviderGroups` (`models/login.ts`) matches an IdP-reported group name against every mappable
group with `name.trim().toLowerCase()`. Two groups named "Editors" and "editors " therefore both
matched one claim, and a login granted (and a removal revoked) both. The index makes the matcher's
own fold the definition of "the same name", so one claim resolves to at most one group.

- **`createGroup` / `updateGroup`** surface a collision as a 409 `groupNameTaken` `CustomError`,
  which `POST /_api/groups` and `PUT /_api/groups/:groupId` re-throw rather than folding into a 500.
  The database index decides, not a read-then-write check, so two concurrent requests cannot both win.
  A group may change only the case or spacing of its own name.
- **`createGroupFromImport`** (the 2.5.x importer) suffixes a colliding name instead of skipping the
  group or failing the import, since Wiki.js 2.5 allowed duplicates: `Editors`, then `Editors (2)`,
  `Editors (3)`, and so on, truncating the base so the result still fits the 255-character column.
  The importer keys memberships by id, so the rename is invisible to it; an administrator can
  rename the group afterwards.

## Why suffix rather than skip or fail

Skipping would silently drop a group, and every membership and rule with it. Failing would stop a
whole import over a cosmetic collision the source system considered valid. A suffix keeps every
record and every membership, and the result is visible in the admin group list.
