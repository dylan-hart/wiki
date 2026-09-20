/**
 * **Both queries must carry the same `where`** — a count over a different predicate than the rows
 * is a paginator that lies, and nothing downstream can detect it.
 *
 * `total` returns drizzle's `select({ total: count() })` row array rather than a bare number because
 * `db.$count` cannot express a count across a join. The `total` alias is load-bearing: any other
 * spelling silently paginates as `total: 0`.
 */
export async function paginate<T>(opts: {
  rows: () => Promise<T[]>
  total: () => Promise<{ total: number }[]>
}): Promise<{ total: number; rows: T[] }> {
  const [rows, totals] = await Promise.all([opts.rows(), opts.total()])
  return { total: totals[0]?.total ?? 0, rows }
}
