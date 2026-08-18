import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatReportTable, reportsToJson } from './render.ts'
import type { PhaseReport } from './report.ts'

const sampleReports: PhaseReport[] = [
  {
    phase: 'settings',
    found: 0,
    wouldCreate: 0,
    wouldSkipExisting: 0,
    conflicts: [],
    unmappable: []
  },
  {
    phase: 'users',
    found: 3,
    wouldCreate: 2,
    wouldSkipExisting: 0,
    conflicts: [],
    unmappable: [
      {
        identifier: 'bob@example.com',
        reason: 'unsupported-auth-provider',
        detail: 'providerKey "ldap" has no matching 3.0 authentication module.'
      }
    ]
  },
  {
    phase: 'assets',
    found: 0,
    wouldCreate: 0,
    wouldSkipExisting: 0,
    conflicts: [
      { identifier: 'file.png', detail: 'two source files map to the same destination path' }
    ],
    unmappable: [
      { identifier: 'comments', reason: 'no-destination-table', detail: 'blocked on Epic 335' }
    ]
  }
]

describe('formatReportTable', () => {
  test('renders a header row and one row per phase', () => {
    const table = formatReportTable(sampleReports)
    const lines = table.split('\n')
    assert.match(lines[0], /Phase/)
    assert.match(lines[0], /Found/)
    assert.match(lines[0], /Would Create/)
    assert.match(lines[0], /Would Skip/)
    assert.match(lines[0], /Conflicts/)
    assert.match(lines[0], /Unmappable/)
    assert.ok(table.includes('settings'))
    assert.ok(table.includes('users'))
    assert.ok(table.includes('assets'))
  })

  test('includes a detail line per conflict and per unmappable entry', () => {
    const table = formatReportTable(sampleReports)
    assert.ok(table.includes('conflict: file.png'))
    assert.ok(table.includes('unmappable (unsupported-auth-provider): bob@example.com'))
    assert.ok(table.includes('unmappable (no-destination-table): comments'))
  })

  test('handles an empty report list', () => {
    assert.equal(formatReportTable([]), '(no phases ran)')
  })
})

describe('reportsToJson', () => {
  test('round-trips through JSON.parse', () => {
    const parsed = JSON.parse(reportsToJson(sampleReports))
    assert.deepEqual(parsed, sampleReports)
  })
})
