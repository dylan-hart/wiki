# Recommended comment changes: `backend/core/scheduler.ts`

Follows OpenProject #3477 (`stopping` flag; `processJob()` wraps `claimAndRun()`).

- **Delete** the `FIXME:` block in `stop()` ("the `newJob` NOTIFY handler still calls
  `processJob()` until the listener closes ..."). The `stopping` flag set at the top of `stop()`
  and checked at the top of `processJob()` fixes it.
- **Trim** the `inFlightJobs` doc comment: it now also holds each whole `processJob()` call (claim
  and run), not only `runJob` promises, so `stop()` waits for a claim already under way.
- **Move** the `processJob` JSDoc's claim/run description onto `claimAndRun()`, which now holds the
  body it describes; `processJob()` itself needs no comment beyond "returns at once once `stop()`
  has begun".
- **Reword** the `stop()` JSDoc's "so polling claims nothing new" to say `stopping` is what
  guarantees that for both polling and the `newJob` handler; the intervals being cleared alone did
  not.
