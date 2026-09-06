# Logging call-site inventory (2026-09-05)

Every `WIKI.logger.{error,warn,info,debug}` call in `backend/` outside `*.test.ts`, counted by file
at commit `8559fbcbe`. 481 calls, 112 files. Generated from a source scan; the verdict column in the
second table is hand-written for the files that account for most of the volume, using the finding
ids from [2026-09-05-audit.md](2026-09-05-audit.md) and the level policy in
[2026-09-05-recommendations.md](2026-09-05-recommendations.md#3-level-policy).

## By area

| Area | Files | Calls |
| --- | ---: | ---: |
| `models/` | 34 | 159 |
| `tasks/` | 31 | 128 |
| `core/` | 10 | 69 |
| `modules/` | 12 | 54 |
| `api/` | 9 | 26 |
| `helpers/` | 9 | 25 |
| root (`index.ts`, `worker.ts`, CLI tasks) | 4 | 15 |
| `controllers/` | 2 | 3 |
| `mcp/` | 1 | 2 |

## Verdicts for the heaviest files

| File | Calls | Verdict |
| --- | ---: | --- |
| `core/scheduler.ts` | 24 | V1/X1/X3: `Processing`/`Completed`/`Scheduling` → `debug`; failure lines gain `attempt=`, `next=`, `error=` (5.2); `warn(err)` at 172/497/847 need a sentence; pool online/offline stay `debug` |
| `core/db.ts` | 20 | X8: seven boot progress lines → one `db connected`; `[SQL]` → scope `sql` at `debug`; V5: event receipt → `debug cluster`; keep pool-error `error` and the retry `warn` |
| `tasks/migrate.ts` | 17 | CLI, scope `migrate`; keep verbose — it is a one-shot tool whose output *is* the report. Drop the `=====` banner and `Wiki.js` |
| `models/icons.ts` | 15 | nine `warn`s carry `[ SKIPPED ]`/`[ FAILED ]` tags and three are two-line (R5); `Added/Deleted icon set` stay `info`; `Fetching <url>` stays `debug` |
| `models/locales.ts` | 12 | V7/X4: 112 boot lines → one; `Reloading locales cache...` → `debug`; keep the sideload summary and skipped-file `warn` |
| `models/extensions.ts` | 12 | X10: per-extension `logState()` → one summary; install stays `info` with `package=`; npm stderr tail stays in `error=` |
| `tasks/simple/update-locales.ts` | 10 | scope `locale`; the offline-mode notice is `debug` (it repeats daily); per-language `debug` stays; the two-line failure becomes one |
| `index.ts` | 10 | X7: banner → one `boot starting`; `HTTP Server: [ RUNNING ]` → `http listening`; add `boot ready` (N1); stack on boot failure regardless of `IS_DEBUG` (C3) |
| `tasks/verify-migration.ts` | 9 | as `migrate.ts` |
| `models/tree.ts` | 9 | all `debug`, all fine; drop the trailing `...`/`successfully.` and add `folder=`, `path=` fields |
| `models/authentication.ts` | 9 | `Enabled authentication strategy X [ OK ]` per strategy → one `info auth enabled N strategies  keys=…`; the `error(err)` pairs become single calls |
| `core/collab.ts` | 9 | scope `collab`; the init `[ OK ]` → `debug`; the six `warn`s are correctly levelled and already one-line |
| `tasks/simple/send-watch-digests.ts` | 8 | the `...`/`[ COMPLETED ]` pair → one line, `info` only when `sent > 0`; per-user `no email address` → `debug` (it recurs every run for the same user); the two-line failures become one |
| `models/storage.ts` | 8 | `Registering/Registered` pair → one; `Found N storage modules` → `debug`; the four `warn`s are right |
| `models/blocks.ts` | 8 | as `storage.ts`; the stale-manifest `warn` is a good line — keep |
| `api/auth/site.ts` | 8 | V8: eight `debug(err)` on unexpected exceptions → `error` with `error: err` and `reqId`; `authDebug` lines become `debug auth` |
| `modules/storage/git/sync.ts` | 7 | `(STORAGE/GIT)` prefix → scope + `target=`; pull/push announcements → `debug`; the deletion-threshold `warn` is exactly right — keep verbatim |
| `models/hooks.ts` | 7 | scope `hooks`; `Delivered X to webhook` stays `debug`; `no longer exists, skipping` → `debug` |
| `tasks/simple/check-version.ts` | 6 | X11: silent unless an update exists; offline notice → `debug` |
| `modules/search/aws-cloudsearch/search.ts` | 6 | per-locale `Reindexed N page(s) in <locale>` → `debug`; keep the rebuild summary |
| `models/login.ts` | 6 | e-mail addresses at 640/1302 → user ids (C4); `warn(errc)` ×3 need a sentence |
| `models/assetServing.ts` | 6 | three two-line `warn`s → one each; `Purged the file cache` stays `info` |
| `tasks/simple/notify-page-watchers.ts` | 5 | as `send-watch-digests.ts` |
| `modules/storage/sftp/storage.ts` | 5 | `${LOG_PREFIX}` → scope; `Exported N so far...` progress → `debug` |
| `modules/search/db/search.ts` | 5 | per-locale reindex → `debug`; dictionary-fallback `warn` is right |
| `modules/search/azure-search/search.ts` | 5 | as aws |
| `models/search.ts` | 5 | `(SEARCH)` prefix → scope; two-line failures → one |
| `models/replication.ts` | 5 | `Replication pull skipped: replication is disabled.` → `debug` (it is the common case, every 5 minutes) |
| `models/commentProviders.ts` | 5 | as `storage.ts` |
| `helpers/rateLimit.ts` | 5 | V8: bans → `warn auth` with `ip=`/`key=`, coalesced (5.3) |
| `helpers/images.ts` | 5 | scope `assets`; fine at `warn`; the thumbnail failure at `debug` is right |
| `api/icons.ts` | 5 | five bare `warn(err.message)` → one-line with a sentence; or drop — the reply already carries the message and the route is admin-only |
| every `tasks/simple/purge-*.ts`, `clean-*.ts`, `*-tick.ts` | 2–4 each | X1/X2/X12: one `info` line when `count > 0`, otherwise silent; the outcome line moves to the scheduler |

## Full table

| File | Total | error | warn | info | debug |
| --- | ---: | ---: | ---: | ---: | ---: |
| `core/scheduler.ts` | 24 | 0 | 10 | 11 | 3 |
| `core/db.ts` | 20 | 6 | 3 | 10 | 1 |
| `tasks/migrate.ts` | 17 | 3 | 0 | 14 | 0 |
| `models/icons.ts` | 15 | 0 | 9 | 4 | 2 |
| `modules/storage/git/actions.ts` | 14 | 0 | 7 | 7 | 0 |
| `models/extensions.ts` | 12 | 0 | 5 | 6 | 1 |
| `models/locales.ts` | 12 | 0 | 5 | 7 | 0 |
| `index.ts` | 10 | 3 | 0 | 7 | 0 |
| `tasks/simple/update-locales.ts` | 10 | 2 | 3 | 3 | 2 |
| `core/collab.ts` | 9 | 0 | 7 | 1 | 1 |
| `models/authentication.ts` | 9 | 4 | 2 | 3 | 0 |
| `models/tree.ts` | 9 | 0 | 0 | 0 | 9 |
| `tasks/verify-migration.ts` | 9 | 1 | 0 | 8 | 0 |
| `api/auth/site.ts` | 8 | 0 | 0 | 0 | 8 |
| `models/blocks.ts` | 8 | 0 | 4 | 4 | 0 |
| `models/storage.ts` | 8 | 2 | 3 | 3 | 0 |
| `tasks/simple/send-watch-digests.ts` | 8 | 4 | 1 | 3 | 0 |
| `models/hooks.ts` | 7 | 0 | 5 | 1 | 1 |
| `modules/storage/git/sync.ts` | 7 | 0 | 4 | 3 | 0 |
| `models/assetServing.ts` | 6 | 0 | 4 | 1 | 1 |
| `models/login.ts` | 6 | 0 | 6 | 0 | 0 |
| `modules/search/aws-cloudsearch/search.ts` | 6 | 0 | 0 | 6 | 0 |
| `tasks/simple/check-version.ts` | 6 | 2 | 0 | 4 | 0 |
| `api/icons.ts` | 5 | 0 | 5 | 0 | 0 |
| `helpers/images.ts` | 5 | 0 | 4 | 0 | 1 |
| `helpers/rateLimit.ts` | 5 | 0 | 0 | 0 | 5 |
| `models/commentProviders.ts` | 5 | 2 | 0 | 3 | 0 |
| `models/replication.ts` | 5 | 0 | 2 | 3 | 0 |
| `models/search.ts` | 5 | 2 | 2 | 1 | 0 |
| `modules/search/azure-search/search.ts` | 5 | 0 | 0 | 5 | 0 |
| `modules/search/db/search.ts` | 5 | 0 | 2 | 3 | 0 |
| `modules/storage/sftp/storage.ts` | 5 | 0 | 1 | 4 | 0 |
| `tasks/simple/notify-page-watchers.ts` | 5 | 4 | 1 | 0 | 0 |
| `api/users/admin.ts` | 4 | 0 | 4 | 0 | 0 |
| `core/config.ts` | 4 | 1 | 1 | 2 | 0 |
| `core/processGuards.ts` | 4 | 4 | 0 | 0 | 0 |
| `helpers/moduleRegistry.ts` | 4 | 0 | 2 | 0 | 2 |
| `models/approvalNotifications.ts` | 4 | 0 | 4 | 0 | 0 |
| `models/approvals.ts` | 4 | 0 | 1 | 0 | 3 |
| `models/renderQueue.ts` | 4 | 0 | 3 | 0 | 1 |
| `models/sites.ts` | 4 | 0 | 0 | 3 | 1 |
| `modules/search/algolia/search.ts` | 4 | 0 | 2 | 2 | 0 |
| `tasks/simple/clean-audit-log.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/clean-job-history.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/export-content.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/export-replication.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/import-content.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/purge-guest-pii.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/purge-page-drafts.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/purge-rate-limits.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/replication-import.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/replication-tick.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/scan-page-problems.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/storage-daily-backup.ts` | 4 | 2 | 0 | 2 | 0 |
| `tasks/simple/storage-sync-tick.ts` | 4 | 2 | 0 | 2 | 0 |
| `api/groups.ts` | 3 | 0 | 3 | 0 | 0 |
| `core/http/server.ts` | 3 | 0 | 1 | 2 | 0 |
| `helpers/errorHandler.ts` | 3 | 0 | 3 | 0 | 0 |
| `helpers/pubsub.ts` | 3 | 0 | 3 | 0 | 0 |
| `models/analytics.ts` | 3 | 2 | 0 | 1 | 0 |
| `models/auditLog.ts` | 3 | 0 | 2 | 1 | 0 |
| `models/groups.ts` | 3 | 0 | 1 | 2 | 0 |
| `models/pageHistory.ts` | 3 | 0 | 2 | 1 | 0 |
| `models/pages.ts` | 3 | 0 | 2 | 0 | 1 |
| `modules/search/elasticsearch/search.ts` | 3 | 0 | 0 | 3 | 0 |
| `tasks/promote-admin.ts` | 3 | 0 | 0 | 3 | 0 |
| `tasks/simple/dispatch-storage.ts` | 3 | 0 | 1 | 1 | 1 |
| `tasks/simple/notify-event-subscribers.ts` | 3 | 2 | 1 | 0 | 0 |
| `tasks/simple/notify-event-subscription-subscribers.ts` | 3 | 2 | 1 | 0 | 0 |
| `api/sites.ts` | 2 | 0 | 2 | 0 | 0 |
| `controllers/terminal.ts` | 2 | 0 | 0 | 2 | 0 |
| `core/maintenance.ts` | 2 | 0 | 0 | 2 | 0 |
| `helpers/puppeteer.ts` | 2 | 0 | 1 | 0 | 1 |
| `mcp/http.ts` | 2 | 0 | 0 | 0 | 2 |
| `migration/bootstrap.ts` | 2 | 0 | 2 | 0 | 0 |
| `models/apiKeys.ts` | 2 | 0 | 0 | 2 | 0 |
| `models/classificationLevels.ts` | 2 | 0 | 0 | 2 | 0 |
| `models/flags.ts` | 2 | 0 | 0 | 2 | 0 |
| `models/jobs.ts` | 2 | 0 | 1 | 1 | 0 |
| `models/mail.ts` | 2 | 0 | 2 | 0 | 0 |
| `models/pageviews.ts` | 2 | 0 | 1 | 1 | 0 |
| `models/settings.ts` | 2 | 0 | 0 | 2 | 0 |
| `models/userCredentials.ts` | 2 | 0 | 0 | 0 | 2 |
| `models/users.ts` | 2 | 0 | 1 | 1 | 0 |
| `modules/storage/disk/storage.ts` | 2 | 0 | 1 | 1 | 0 |
| `tasks/simple/replication-pull.ts` | 2 | 2 | 0 | 0 | 0 |
| `worker.ts` | 2 | 2 | 0 | 0 | 0 |
| `api/auth/provider.ts` | 1 | 0 | 1 | 0 | 0 |
| `api/blocks.ts` | 1 | 0 | 1 | 0 | 0 |
| `api/mail.ts` | 1 | 0 | 1 | 0 | 0 |
| `api/storage.ts` | 1 | 0 | 1 | 0 | 0 |
| `controllers/metrics.ts` | 1 | 0 | 0 | 0 | 1 |
| `core/http/authHooks.ts` | 1 | 0 | 0 | 0 | 1 |
| `core/http/siteRouting.ts` | 1 | 1 | 0 | 0 | 0 |
| `core/logger.ts` | 1 | 1 | 0 | 0 | 0 |
| `helpers/advisoryLock.ts` | 1 | 0 | 1 | 0 | 0 |
| `helpers/requestLogContext.ts` | 1 | 0 | 1 | 0 | 0 |
| `helpers/security.ts` | 1 | 0 | 1 | 0 | 0 |
| `models/approvalRules.ts` | 1 | 0 | 0 | 1 | 0 |
| `models/comments.ts` | 1 | 0 | 0 | 1 | 0 |
| `models/sessions.ts` | 1 | 0 | 0 | 1 | 0 |
| `modules/authentication/ldap/authentication.ts` | 1 | 0 | 1 | 0 | 0 |
| `modules/search/externalBase.ts` | 1 | 0 | 1 | 0 | 0 |
| `modules/storage/blobBase.ts` | 1 | 0 | 0 | 1 | 0 |
| `tasks/simple/purge-content-sync-state.ts` | 1 | 0 | 0 | 1 | 0 |
| `tasks/simple/purge-exports.ts` | 1 | 0 | 0 | 1 | 0 |
| `tasks/simple/purge-imports.ts` | 1 | 0 | 0 | 1 | 0 |
| `tasks/simple/purge-page-watch-events.ts` | 1 | 0 | 0 | 1 | 0 |
| `tasks/simple/purge-pageviews.ts` | 1 | 0 | 0 | 1 | 0 |
| `tasks/simple/purge-sessions.ts` | 1 | 0 | 0 | 1 | 0 |
| `tasks/simple/purge-user-keys.ts` | 1 | 0 | 0 | 1 | 0 |
| `test/mocks.ts` | 1 | 0 | 0 | 1 | 0 |
