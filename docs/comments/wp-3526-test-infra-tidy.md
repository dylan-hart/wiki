# WP #3526: recommended comment changes

The code changes for these four items are done; the marker comments they resolve are left in place
per project rules and should be removed as below.

## `backend/core/scheduler.test.ts`

In `adds no jobs and does not throw when the schedule has no due iterations left`:

- Delete the two-line `FIXME: fails when run in the 24h05m before a Feb 29th ...`. The cron is now
  derived from `Temporal.Now` + 7 days, so it can no longer land inside the window.
- Replace `// Fires on Feb 29th only, so the window holds no due iteration and the loop ends
naturally rather than at the cap.` with:
  `// Fires once a year, a week from now, so the window holds no due iteration and the loop ends naturally rather than at the cap.`

## `backend/core/scheduler.reaping.db.test.ts`

In `sends a jobCompleted NOTIFY for a job it abandons, since nothing else ever will`:

- Delete the `TODO: drop this wait ...` comment. The 50 ms wait is gone. The fake `query()` now
  settles after a real 25 ms, and the test asserts it settled, so it fails if `reapStaleJobs()` stops
  awaiting `notifier.drained()` (verified by removing that await).

## `backend/core/collab.crossInstance.db.test.ts`

- Delete the `TODO: drop this hook and dbWiki ...` comment above `after()`. The `beforeEach` hook,
  `dbWiki` and the `beforeEach` import were removed after a green run without them.

## `backend/test/replicationRoundTrip.db.test.ts`

- In the file header, delete the `TODO: nothing can drive this through a real pull ...` paragraph.
  The test now drives `replication.pull()` (`downloadSnapshot`, the import, the post-import side
  effects) with `fetch` stubbed to serve the file `buildSnapshot()` wrote.
- Optionally reword the header's first paragraph to say it is the round trip through the real pull
  path rather than between the two models directly. The 409 polling branch stays covered by
  `models/replication.test.ts` only, since polling would sleep 5 s here.
