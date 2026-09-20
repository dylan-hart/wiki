# WP 3492: comment changes recommended

- `backend/mcp/tools/getPage.ts`, the `FIXME: unlike helpers/pageAccess.ts#mayReadSource ...` marker above
  `maySeeSource`: delete. `mayReadSourceAs` now ORs `read:source`, `write:pages` and `manage:pages`, so
  the FIXME no longer describes the code.
- `backend/mcp/tools/getPage.ts`, header doc (`includeSource` paragraph): "without `read:source`" should
  read "without `read:source` (or `write:pages`/`manage:pages`, which imply it)".
- `backend/models/approvals.ts`, the doc above `getSubmissionForReview` and the one near the reviewer
  queue: "requires `read:source`" now also holds for `write:pages`/`manage:pages` through
  `mayReadSourceAs`.
- `backend/helpers/pageAccess.ts`, doc above `mayReadSource`: add one line saying `mayReadSourceAs` is the
  actor-based core, for callers with an `AccessActor` and no request (MCP tools, approvals model).
