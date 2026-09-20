# WP 3520: comments made stale by the Cancel Job aria-label

The cancel button now carries `aria-label`, so these comments no longer describe the code.

## `e2e/tests/scheduler.spec.js` (worker-row cancel, above the `getByRole('button', { name: 'Cancel Job' })` click)

Delete the second paragraph (the "Selected by its icon, not `getByRole(...)`" block ending in the
`FIXME`). Keep the first paragraph about `cancelJob()` calling `load()`.

## `frontend/src/pages/AdminScheduler.test.js` (collapsed-group cancel test)

Delete the comment starting "The Cancel Job button has no static aria-label"; the `cancelButton`
helper now selects `button[aria-label="Cancel Job"]`, which needs no explanation.
