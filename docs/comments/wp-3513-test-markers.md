# Backend test markers resolved by OpenProject #3513

The tests these markers describe are now fixed, so each marker can be deleted (not edited).

- `backend/api/assets.test.ts`: delete the `FIXME: the title is wrong...` block in the wrong-site `folderId` 404 test. The title now names the wrong-site check.
- `backend/api/pages/drafts.test.ts`: delete `FIXME: the title says 404, but read-without-write answers 403...`. The title now says 403.
- `backend/api/pages/index.test.ts`: delete the `FIXME: the history route calls pageHistory.list...` comment above the `list` stub. The stub is renamed.
- `backend/api/pages/publishState.test.ts`: delete the `FIXME: this sends draft -> scheduled...` comment. That test is retitled, and the published-to-draft cases now start from a published fixture.
- `backend/core/collab.relay.test.ts`: delete `TODO: t should be 'wysiwyg-claimed'...`. The envelope now uses `t: 'wysiwyg-claimed'`.
