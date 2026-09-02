import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  KNOWN_3_0_AUTH_MODULES,
  classifyUserAuthProvider,
  formatReportTable,
  reportsToJson
} from './report.ts'
import type { PhaseReport } from './report.ts'
describe('KNOWN_3_0_AUTH_MODULES', () => {
  test('matches the real backend/modules/authentication/ directory listing exactly', async () => {
    const authPath = path.join(import.meta.dirname, '..', 'modules', 'authentication')
    const onDisk = (await fs.readdir(authPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    assert.deepEqual([...KNOWN_3_0_AUTH_MODULES].sort(), onDisk)
  })
})

describe('classifyUserAuthProvider', () => {
  // -> Confirmed no-destination five (docs/migration/2.5x-settings-auth-storage-field-mapping.md's
  //    "Confirmed no-destination 2.x auth providers" section): 2.x ships these, 3.0 has no matching
  //    module directory for any of them.
  for (const providerKey of ['azure', 'dropbox', 'facebook', 'firebase', 'rocketchat']) {
    test(`flags "${providerKey}" as unmappable (unsupported-auth-provider)`, () => {
      const result = classifyUserAuthProvider({ providerKey, email: 'alice@example.com' })
      assert.ok(result)
      assert.equal(result.reason, 'unsupported-auth-provider')
      assert.equal(result.identifier, 'alice@example.com')
      assert.match(result.detail, new RegExp(providerKey))
      assert.ok(
        !KNOWN_3_0_AUTH_MODULES.has(providerKey),
        `${providerKey} must not be a real 3.0 module`
      )
    })

    test(`is case-insensitive for "${providerKey.toUpperCase()}"`, () => {
      const result = classifyUserAuthProvider({ providerKey: providerKey.toUpperCase() })
      assert.ok(result)
    })
  }

  // -> Every real 3.0 module — including the twelve that gained a module directory since this set was
  //    last hardcoded (ldap/saml/cas/auth0/okta among them) — must NOT be flagged: they are mappable,
  //    even though their config prop-name mapping may still be unverified (that's the mapper's job,
  //    not this classifier's).
  for (const providerKey of KNOWN_3_0_AUTH_MODULES) {
    test(`does not flag a supported provider ("${providerKey}")`, () => {
      assert.equal(classifyUserAuthProvider({ providerKey }), null)
    })
  }

  test('does not flag an unrecognized provider key', () => {
    assert.equal(classifyUserAuthProvider({ providerKey: 'some-future-provider' }), null)
  })

  test('does not flag a record with no providerKey at all', () => {
    assert.equal(classifyUserAuthProvider({ email: 'alice@example.com' }), null)
  })

  test('falls back to id when email is missing', () => {
    const result = classifyUserAuthProvider({ providerKey: 'firebase', id: 42 })
    assert.equal(result?.identifier, '42')
  })
})

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
      {
        identifier: 'box',
        reason: 'unsupported-storage-module',
        detail: 'no 3.0 storage module for box'
      }
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
    assert.ok(table.includes('unmappable (unsupported-storage-module): box'))
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
