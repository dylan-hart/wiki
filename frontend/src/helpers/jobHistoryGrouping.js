/**
 * Groups the Scheduler admin area's job-history list by task name, so a task that ran many times in
 * a row -- `storageSyncTick`'s every-minute cron tick is the motivating case -- collapses into one
 * summary row instead of drowning out every other task in the Completed/Failed tabs.
 */

/**
 * `jobs` must arrive newest-first, as `GET /_api/scheduler/jobs` returns it: group order and each
 * group's `entries` order are inherited from it, so recency ordering holds only under that.
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
 * A child row carries `groupCount: 1` on purpose: it is a real, individually-actionable entry and
 * must behave exactly like an ungrouped row everywhere else, the retry action included. The summary
 * row's `id` is `group:<task>` rather than any real entry's (a uuid), so a row-keyed table cannot
 * confuse it for one of its children and an id-addressed action gated on `groupCount === 1` can
 * never fire against a row with no real job behind it.
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
