# WP 3498: Ctrl+S save wiring -- recommended comment changes

## `frontend/src/components/EditorMarkdown.vue` (the `save` action in `onMounted`)

Delete the `TODO` above `run()`:

```
// TODO: this only swallows the browser's own save dialog -- Ctrl+S never reaches `pageSave()`,
//       and nothing else in the app binds it. Wire it up or drop the action.
```

It is now false: `run()` flushes the debounced content change and calls `requestSave()`, which the
header's `useSaveShortcut` handles through `usePageSaveFlow().saveChanges()`.

## `frontend/src/composables/saveShortcut.js` (new file, no comments added)

Suggested, in the file's style, above `useSaveShortcut`:

```
/*
  The header owns the save flow, so an editor asks for a save over EVENT_BUS (`requestSave`) rather
  than performing one. The window keydown covers focus no editor binding reaches (WYSIWYG, the
  header). A keydown Monaco already handled arrives `defaultPrevented` and is skipped, which is
  what stops it saving twice.
*/
```

## `frontend/src/components/PageHeader.vue` (`saveFromShortcut`)

Suggested above the function:

```
// -> Mirrors the template's suggest / create / save chain, including the save button's
//    `hasPendingChanges` gate. Ignored while a dialog is open so a second press cannot stack
//    another reason-for-change dialog.
```
