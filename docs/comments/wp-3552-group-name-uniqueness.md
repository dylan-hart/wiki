# Recommended comment changes: unique group names (OpenProject #3552)

## `backend/db/schema.ts`, above `uniqueIndex('groups_name_normalized_idx')`

Add:

```ts
// -> Same fold as `models/login.ts#syncProviderGroups` (`trim().toLowerCase()`), so one IdP claim
//    can never match two groups. Keep the two in sync.
```

## `backend/models/groups.ts`

- `createGroupFromImport` doc comment: append "A name colliding with an existing group
  (`groups_name_normalized_idx`) is suffixed ` (2)`, ` (3)`, ... rather than refused; Wiki.js 2.5
  allowed duplicates."
- `nameTakenError`: add "The unique index decides, so a concurrent create or rename cannot race a
  read-then-write check; `23505` is that index refusing the name."
