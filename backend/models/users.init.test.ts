import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { installTestWiki } from '../test/mocks.ts'
import { users } from './users.ts'
import type { SystemIds } from './types.ts'

const IDS: SystemIds = {
  groupAdminId: 'group-admin-id',
  groupUserId: 'group-user-id',
  groupGuestId: 'group-guest-id',
  siteId: 'site-id',
  authModuleId: 'local',
  userAdminId: 'user-admin-id',
  userGuestId: 'user-guest-id',
  classificationPublicId: 'classification-public-id',
  classificationInternalId: 'classification-internal-id',
  classificationRestrictedId: 'classification-restricted-id'
}

interface CapturedInsert {
  table: unknown
  rows: any[]
}

function installWikiWithDbCapture(): {
  restore(): void
  inserts: CapturedInsert[]
  errorLog: ReturnType<typeof mock.fn>
} {
  const inserts: CapturedInsert[] = []
  const errorLog = mock.fn()
  const handle = installTestWiki({
    db: {
      insert: mock.fn((table: unknown) => ({
        values: mock.fn(async (rows: any[]) => {
          inserts.push({ table, rows })
          return { rowCount: rows.length }
        })
      }))
    }
  })
  CARDINAL.logger.error = errorLog
  return { restore: handle.restore, inserts, errorLog }
}

function adminRow(inserts: CapturedInsert[]): any {
  const usersInsert = inserts.find((insert) =>
    insert.rows.some((row) => row.id === IDS.userAdminId)
  )
  assert.ok(usersInsert, 'expected a users-table insert carrying the admin row')
  return usersInsert!.rows.find((row) => row.id === IDS.userAdminId)
}

describe('users.init — admin password seeding', () => {
  const previousAdminPass = process.env.ADMIN_PASS
  const previousAdminEmail = process.env.ADMIN_EMAIL

  beforeEach(() => {
    delete process.env.ADMIN_PASS
    delete process.env.ADMIN_EMAIL
  })

  afterEach(() => {
    if (previousAdminPass === undefined) {
      delete process.env.ADMIN_PASS
    } else {
      process.env.ADMIN_PASS = previousAdminPass
    }
    if (previousAdminEmail === undefined) {
      delete process.env.ADMIN_EMAIL
    } else {
      process.env.ADMIN_EMAIL = previousAdminEmail
    }
  })

  test('ADMIN_PASS unset: seeds a random password, not the old fixed default', async () => {
    const { restore, inserts, errorLog } = installWikiWithDbCapture()
    try {
      await users.init(IDS)

      const row = adminRow(inserts)
      const storedHash = row.auth[IDS.authModuleId].password

      assert.equal(
        await bcrypt.compare('12345678', storedHash),
        false,
        'the old fixed default must no longer verify'
      )
      assert.equal(row.auth[IDS.authModuleId].mustChangePwd, true)

      assert.equal(
        errorLog.mock.callCount(),
        1,
        'the one-time password must be logged exactly once'
      )
      const [scope, message, fields] = errorLog.mock.calls[0]!.arguments as [string, string, any]
      assert.equal(scope, 'config')
      assert.match(message, /one-time admin password/)
      assert.equal(fields.email, 'admin@example.com')
      assert.equal(typeof fields.password, 'string')
      assert.ok(
        fields.password.length >= 20,
        'expected a real amount of entropy, not a short token'
      )

      assert.equal(
        await bcrypt.compare(fields.password, storedHash),
        true,
        'the logged password must be exactly the one that was hashed and stored'
      )
    } finally {
      restore()
    }
  })

  test('two separate init() runs produce two different generated passwords', async () => {
    const first = installWikiWithDbCapture()
    let firstPassword: string
    try {
      await users.init(IDS)
      firstPassword = (first.errorLog.mock.calls[0]!.arguments as any[])[2].password
    } finally {
      first.restore()
    }

    const second = installWikiWithDbCapture()
    let secondPassword: string
    try {
      await users.init(IDS)
      secondPassword = (second.errorLog.mock.calls[0]!.arguments as any[])[2].password
    } finally {
      second.restore()
    }

    assert.notEqual(firstPassword, secondPassword)
  })

  test('ADMIN_PASS set: hashes the given value, does not log, and skips the forced change', async () => {
    process.env.ADMIN_PASS = 'a-deliberately-chosen-operator-password'
    const { restore, inserts, errorLog } = installWikiWithDbCapture()
    try {
      await users.init(IDS)

      const row = adminRow(inserts)
      const storedHash = row.auth[IDS.authModuleId].password

      assert.equal(
        await bcrypt.compare('a-deliberately-chosen-operator-password', storedHash),
        true
      )
      assert.equal(row.auth[IDS.authModuleId].mustChangePwd, false)
      assert.equal(
        errorLog.mock.callCount(),
        0,
        'no password should be logged when ADMIN_PASS is set'
      )
    } finally {
      restore()
    }
  })

  test('ADMIN_EMAIL set: seeds and logs that address instead of the default', async () => {
    process.env.ADMIN_EMAIL = 'owner@instance.example'
    const { restore, inserts, errorLog } = installWikiWithDbCapture()
    try {
      await users.init(IDS)

      const row = adminRow(inserts)
      assert.equal(row.email, 'owner@instance.example')
      assert.equal((errorLog.mock.calls[0]!.arguments as any[])[2].email, 'owner@instance.example')
    } finally {
      restore()
    }
  })
})
