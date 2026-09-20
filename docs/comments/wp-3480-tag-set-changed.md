# WP 3480: recommended comment removal

`backend/api/pages/write.ts`, above `tagSetChanged`: delete the `FIXME` (two lines, "not a true set
comparison ... Compare against `new Set(next)`"). `tagSetChanged` now compares `new Set(current)`
against `new Set(next)` by size and membership, so the defect it describes no longer exists.
