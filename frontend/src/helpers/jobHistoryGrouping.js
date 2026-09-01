/**
 * Groups the Scheduler admin area's job-history list by task name, so a task that ran many times in
 * a row -- `storageSyncTick`'s every-minute cron tick is the motivating case, OpenProject #2337 --
 * collapses into one summary row instead of drowning out every other task in the Completed/Failed
 * tabs.
 *
 * Nothing here talks to the scheduler or changes what gets recorded: `AdminScheduler.vue`'s
 * `scheduler/jobs` fetch is untouched, and the raw list is still what `state.jobsTotal` and the
 * "Showing the N most recent of M jobs" caption count against. This purely reshapes how that list
 * renders.
 */

/**
 * @param {Array<{ task: string }>} jobs A job-history list, newest-first (what `GET
 *   /_api/scheduler/jobs` already returns -- see its own `description`).
 * @returns {Array<{ task: string, entries: object[], count: number }>} One group per distinct task
 *   name, in the order each task's most recent entry appears in `jobs` -- since `jobs` is
 *   newest-first, that is also each group's own recency order. `entries` keeps its members in their
 *   original (newest-first) relative order.
 */
export function groupJobHistory(jobs) {
  const groups = []
  const byTask = new Map()
  for (const job of jobs ?? []) {
    let group = byTask.get(job.task)
    if (!group) {
      group = { task: job.task, entries: [] }
      byTask.set(job.task, group)
      groups.push(group)
    }
    group.entries.push(job)
  }
  return groups.map((group) => ({ ...group, count: group.entries.length }))
}

/**
 * Flattens `groupJobHistory`'s output into the row list a `<w-table>` renders.
 *
 * A task with exactly one entry renders exactly as it always did (`groupCount: 1`, no group chrome).
 * A task with two or more entries renders as a single synthetic summary row instead -- built from
 * the group's most recent entry's own fields (so its state icon/date/etc. reflect the latest run),
 * plus `groupCount` (the badge count), `groupTask` (what the expand toggle addresses) and
 * `groupExpanded`. Expanding it (`expandedTasks.has(task)`) additionally lists every entry in the
 * group underneath, each marked `groupChild: true` and `groupCount: 1` -- `groupCount: 1` on purpose,
 * since a child row is a real, individually-actionable entry and should be treated exactly like an
 * ungrouped row everywhere else (in particular: eligible for the retry action).
 *
 * The summary row's `id` is deliberately NOT any real entry's id -- `group:<task>` instead, which
 * cannot collide with a real job id (a uuid) -- specifically so a row-keyed table can never confuse
 * it for one of its own children, and so a caller gating an id-addressed action (retry) on
 * `groupCount === 1` can never have that action fire against a row with no real job behind it.
 *
 * @param {object[]} jobs A job-history list, newest-first.
 * @param {Set<string>} [expandedTasks] Task names currently expanded. Absent/empty expands nothing.
 * @returns {object[]}
 */
export function flattenJobHistoryRows(jobs, expandedTasks) {
  const rows = []
  for (const group of groupJobHistory(jobs)) {
    if (group.count === 1) {
      rows.push({ ...group.entries[0], groupCount: 1 })
      continue
    }
    const expanded = expandedTasks?.has(group.task) ?? false
    rows.push({
      ...group.entries[0],
      id: `group:${group.task}`,
      groupCount: group.count,
      groupTask: group.task,
      groupExpanded: expanded
    })
    if (expanded) {
      for (const entry of group.entries) {
        rows.push({ ...entry, groupCount: 1, groupChild: true })
      }
    }
  }
  return rows
}
