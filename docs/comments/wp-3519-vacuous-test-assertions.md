# WP 3519: FIXME markers to remove

Each FIXME below described a vacuous or weak assertion that this work package fixed; the marker is
now stale and should be deleted (the surrounding explanatory comments stay as they are).

- `backend/models/siteImport.test.ts`: the two-line `FIXME: the assertion below is vacuous ...` above
  `leftoverOnSource`.
- `backend/core/scheduler.test.ts`: the two-line `FIXME: asserts only the fake's own insertedJobs ...`
  above `reports zero jobs added when every addJob insert fails`.
- `backend/models/mail.test.ts`: the three-line `FIXME: tfaNewDeviceLogin has a wrapper ...` in
  `every MailKind but approval is covered by a wrapper above`.
- `backend/core/scheduler.reaping.db.test.ts`: the three-line `FIXME: backdate jobs.waitUntil first ...`
  before the second `processJob()` in `reclaiming after an interruption advances attempt ...`. Keep
  the `The retry reclaims the SAME jobHistory row ...` lines above it.
- `frontend/src/components/FileManager.test.js`: the two-line `FIXME: this only asserts the value is
  non-empty ...` in `never falls back to a raw toLocaleString() call of its own`.
- `frontend/src/pages/Index.view.test.js`: the two-line `FIXME: :has-text() is a Playwright selector
  ...` in `does not render the chip when publishState is not "draft"`.

Optional: the `Record<Exclude<MailKind, 'approval'>, true>` literal in `mail.test.ts` could carry a
one-line why ("a new MailKind must fail typecheck here until it is tabled or excluded"); the
`-> approval is composed outside this model` comment above it already covers the exclusion.
