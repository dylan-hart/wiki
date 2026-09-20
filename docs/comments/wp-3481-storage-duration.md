# WP 3481: storage schedule-override duration check

Recommended comment changes, not applied per the comments rule.

## `backend/migration/mappers/storage.ts`, `convertSyncInterval`

Delete the `FIXME:` block above `if (isIsoDuration(trimmed))`. The importer now validates with the
model's own `isIsoDuration`, so the defect it describes no longer exists. The block was dedented one
level when the surrounding `try` was removed; its text is otherwise unchanged. The `// -> Not an
ISO-8601 duration; fall through` comment went with that `try`'s `catch`.

## `backend/models/storage.ts`

- `ISO_DURATION_PATTERN` doc comment: add that years, months and weeks are excluded on purpose,
  because `isScheduleDue` flattens with `total({ unit: 'milliseconds' })` and no `relativeTo`, which
  throws on them. Suggested text: "An ISO-8601 duration of exact length, such as `PT5M` or
  `P1DT12H`. Years, months and weeks are excluded: `isScheduleDue` cannot total them without a
  calendar."
- `isScheduleDue` doc comment: the sentence about `total()` throwing on `years`/`months` describes a
  case the pattern now refuses before it can reach `total()`; trim it to a pointer at
  `ISO_DURATION_PATTERN`.
