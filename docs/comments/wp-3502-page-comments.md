# Recommended comment changes: WP #3502

## `frontend/src/components/PageComments.vue`

**Delete** the `FIXME:` block that sat above the removed `canModerate` computed (starts "the list
endpoint sends `authorId` but no resolved `canEdit`/`canDelete` flag"). It is resolved: the list, POST
and PATCH responses now carry `canEdit`/`canDelete`, and the template gates each control on them. It
is left in place in this change only because comment edits are routed through this file.

## `backend/api/comments.ts`

No change needed. `moderationFlags` and `toPublicComment` carry doc comments already, and the
`maySelfModerate` comment still matches its code.
