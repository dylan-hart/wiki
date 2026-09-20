# WP 3488: update check comment recommendations

## `frontend/src/components/CheckUpdateDialog.vue`

- **Delete** the `// FIXME: hardcoded, so the dialog always reports ...` block above the `status`
  computed. It described the removed `isLatest = true` stub and `state.canUpgrade`, neither of which
  exists any more; nothing true remains.

## `backend/tasks/simple/check-version.ts`

- **Add** (optional, 2 lines) above the `releases` filter, the why behind the list endpoint: the
  list endpoint is used rather than `/releases/latest`, which 404s while every release is a
  prerelease (the `3.0.0-alpha.N` line); a stable install is not offered prereleases.

## `backend/base.yml` / `config.sample.yml`

- **Add** (optional) beside `update.releasesUrl`: the feed the daily version check and the admin
  "Check for Updates" button read; it must speak the GitHub "list releases" API shape and defaults
  to this project's own releases.
