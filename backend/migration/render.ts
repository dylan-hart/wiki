import type { PhaseReport } from './report.ts'

type ColumnKey =
  | 'phase'
  | 'found'
  | 'wouldCreate'
  | 'wouldSkipExisting'
  | 'conflictCount'
  | 'unmappableCount'

const COLUMNS: { key: ColumnKey; header: string }[] = [
  { key: 'phase', header: 'Phase' },
  { key: 'found', header: 'Found' },
  { key: 'wouldCreate', header: 'Would Create' },
  { key: 'wouldSkipExisting', header: 'Would Skip' },
  { key: 'conflictCount', header: 'Conflicts' },
  { key: 'unmappableCount', header: 'Unmappable' }
]

function cell(report: PhaseReport, key: ColumnKey): string {
  switch (key) {
    case 'conflictCount':
      return String(report.conflicts.length)
    case 'unmappableCount':
      return String(report.unmappable.length)
    default:
      return String(report[key])
  }
}

/**
 * Renders the aggregate dry-run report as a plain-text table, one row per phase, plus a detail line
 * per conflict/unmappable entry beneath it — the console default (Feature 421 task 744). Returns a
 * plain string rather than printing directly, so a caller can choose stdout vs. the structured logger
 * vs. a test assertion. `--report-file` additionally writes the same reports as JSON (`reportsToJson`)
 * for diffing between runs.
 */
export function formatReportTable(reports: PhaseReport[]): string {
  if (reports.length === 0) {
    return '(no phases ran)'
  }

  const rows = reports.map((report) => COLUMNS.map((column) => cell(report, column.key)))
  const widths = COLUMNS.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => row[i].length))
  )
  const formatRow = (cells: string[]) =>
    cells
      .map((value, i) => value.padEnd(widths[i]))
      .join('  ')
      .trimEnd()

  const lines = [
    formatRow(COLUMNS.map((column) => column.header)),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(formatRow)
  ]

  for (const report of reports) {
    for (const conflict of report.conflicts) {
      lines.push(`  [${report.phase}] conflict: ${conflict.identifier} — ${conflict.detail}`)
    }
    for (const entry of report.unmappable) {
      lines.push(
        `  [${report.phase}] unmappable (${entry.reason}): ${entry.identifier} — ${entry.detail}`
      )
    }
  }

  return lines.join('\n')
}

/** JSON form of the aggregate report, written to `--report-file` for later diffing between runs. */
export function reportsToJson(reports: PhaseReport[]): string {
  return JSON.stringify(reports, null, 2)
}
