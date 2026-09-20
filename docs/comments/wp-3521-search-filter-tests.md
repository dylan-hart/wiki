# Comment changes for OpenProject #3521 (search filter row tests)

Recommended only. The two new files carry no comments; these are the whys worth adding if wanted.

## `frontend/src/pages/Search.filterRows.test.js`

- Above `mountSearch`: "`users/profile` answers with `profile`; every other GET is a search. The
  mocks are installed before mount because the route watcher and `onMounted` both fire during it."
- Above `selectIn`: "Mode, type and dropdown value are `w-select`s whose `data-testid` lands on the
  inner control, so the component is found by name and driven with `update:modelValue`."

## `e2e/tests/search-filters.spec.js`

- Above `openSearchUntilSeeded`: "A search straight after saving can beat indexing, so the visit is
  retried until both seeded pages appear instead of sleeping."
- Above `chooseMode`: "The mode select is a button that opens a listbox; pick the option the way a
  reader does."
- Before the first `waitForResponse(isProfileSave)`: "The preference save is debounced, so the
  response is awaited, not assumed."
- Before `browser.newContext()`: "A clean context shares no cookie or storage, so what appears came
  from the saved preference alone."
- Before `waitForTimeout(1_000)` in the anonymous test: "Past the 500ms save debounce, so a write
  that was going to happen has happened."
