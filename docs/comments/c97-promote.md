# Comment recommendations: note promote header button (#3771)

No existing comment was made stale by this change. `frontend/src/composables/notePromote.js`'s
JSDoc on `submit()` (why the render is made in the browser, and what `noteUpdatedAt` guards) still
reads true, and nothing in `Notes.vue`, `noteAutosave.js` or `notes-promote.spec.js` refers to the
behaviour that changed.

Nothing new is recommended for the promote code itself: the one constraint worth knowing (a caller
passing a live note to `useNotePromote().promote()` has to keep its `updatedAt` in step with its
autosave) is what `Notes.vue`'s `createNoteAutosave({ save })` callback does in plain code, and the
tests beside it enforce it.

## `e2e/playwright.config.js` — add a FIXME on `webServer.url`

A defect found while running `tests/notes-promote.spec.js`, and not fixed by this change. On an empty
database, `GET /` answers 404: the default site has no home page yet, so
`core/http/siteRouting.ts#registerAppShellFallback` serves the app shell with a 404 status. Playwright
treats a 404 from `webServer.url` as "not up yet", so the webServer check waits out its 60s timeout
against a server that is already listening (`boot ready` in its own log). A CI run starts from a
fresh `postgres:18` container, so this is the state it boots in. A local run can get past it only by
reusing a server already running, with the check pointed somewhere that answers 200 (`/login` does).

Suggested text, above `url: BASE_URL,`:

```js
    // FIXME: `/` answers 404 on a fresh database (no home page yet), which Playwright's readiness
    //        check reads as "not up", so the boot times out. Point this at a route that answers 200
    //        on an empty wiki, such as `/login`.
```

Before adding it, confirm that the `build.yml` e2e leg fails the same way. If it does, fix the URL
rather than adding the comment.
