/**
 * Run a paged read and its matching total in one round trip.
 *
 * Six model methods — `users.getUsers`, `groups.getGroupUsers`, `auditLog.getEntries`,
 * `hooks.getDeliveryHistory`, `jobs.getHistory`, `pages.listByClassification` — each wrote out the
 * same three moves: `Promise.all` the row query with a count query over the SAME predicate, then dig
 * the number back out of the single-row result with `totals[0]?.total ?? 0`. Only the two queries
 * ever differed, so those stay at the call site as thunks; what is shared is the concurrency and the
 * unwrap.
 *
 * **Both queries must carry the same `where`.** `total` is what tells a caller it is looking at a
 * truncated view — a count over a different predicate than the rows is a paginator that lies, and
 * nothing downstream can detect it.
 *
 * `total` is a thunk returning drizzle's own `select({ total: count() })` result — the row array, not
 * a bare number — deliberately: `count()` from `drizzle-orm` is the one spelling all six sites now
 * use (one of them had hand-written `sql<number>\`count(*)::int\``), and one of them counts across an
 * `innerJoin`, which `db.$count`'s table-or-subquery shape cannot express. Taking the query's own
 * result keeps every site on that single spelling and puts the `?? 0` in one place. The `total`
 * column alias is load-bearing: this function reads `totals[0]?.total`, so a caller that spells its
 * count query any other way silently paginates everything as `total: 0`.
 */
export async function paginate<T>(opts: {
  rows: () => Promise<T[]>
  total: () => Promise<{ total: number }[]>
}): Promise<{ total: number; rows: T[] }> {
  const [rows, totals] = await Promise.all([opts.rows(), opts.total()])
  return { total: totals[0]?.total ?? 0, rows }
}
