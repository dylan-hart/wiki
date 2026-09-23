# Comment recommendations: note promote header button (#3771)

No existing comment was made stale by this change. `frontend/src/composables/notePromote.js`'s
JSDoc on `submit()` (why the render is made in the browser, and what `noteUpdatedAt` guards) still
reads true, and nothing in `Notes.vue`, `noteAutosave.js` or `notes-promote.spec.js` refers to the
behaviour that changed.

Nothing new is recommended for the promote code itself: the one constraint worth knowing (a caller
passing a live note to `useNotePromote().promote()` has to keep its `updatedAt` in step with its
autosave) is what `Notes.vue`'s `createNoteAutosave({ save })` callback does in plain code, and the
tests beside it enforce it.
