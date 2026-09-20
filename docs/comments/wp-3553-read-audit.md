# Comment recommendations: WP 3553 (read:audit, NDJSON export)

No code comments were added; the whys below are worth recording (trimmed to fit the rubric).

- `backend/models/auditLog.ts`, above `exportBatches`:
  - "Keyset-paged on `(createdAt, id)`, not `OFFSET`: a row recorded mid-export is newer than
    everything already read, and a purge only removes the oldest rows, so neither shifts the pages
    still to come."
  - "The cursor timestamp travels as Postgres text, not a `Date`: the column has microsecond
    precision and a `Date` truncates to milliseconds, which would skip rows sharing a millisecond."
- `backend/models/auditLog.ts`, `AUDIT_EVENTS`, in the `auditLog.*` doc block: `exported`'s `detail`
  carries `{ format, filters }`.
- `backend/api/auditLog.ts`, `/export` handler, above `record()`: "Recorded before the first row is
  read, so an abandoned download still leaves a trail and the export includes the record of itself."
- `frontend/src/pages/AdminAuditLog.vue`: `canManageRetention` -- "`read:audit` lists and exports;
  retention stays with `manage:system`." And in `exportNdjson`'s catch: "Dismissing the save picker
  is not a failure."
- `backend/api/auditLog.test.ts`, the DB-backed export test: "A batch size below the row count is
  what exercises the keyset cursor."
