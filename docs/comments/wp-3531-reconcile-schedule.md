# WP 3531: recommended comments

`backend/models/jobs.ts`, above `Jobs#reconcileSchedule`, add:

```ts
/**
 * Reconciles only `type: 'system'` rows against `JOB_SCHEDULE_SEED`; a row of another type, even one
 * squatting on a seeded task name (the unique index is on `task` alone), is left alone. Callers hold
 * the `wiki:migrate` advisory lock (`core/config.ts#ensureSeeded`), which is what keeps concurrent
 * boots from interleaving. Unchanged rows are not written, so `updatedAt` only moves on a real change.
 */
```

`backend/models/jobs.ts`, on `JOB_SCHEDULE_SEED`: the existing doc says `init()` seeds it. Recommend
extending to "`init()` seeds it on a fresh database and `reconcileSchedule()` re-applies it on every
later boot, so an entry added, retimed or removed here reaches existing instances without a migration."
