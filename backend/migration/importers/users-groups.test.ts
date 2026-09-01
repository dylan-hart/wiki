import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  createDrizzleWriter,
  createDryRunWriter,
  createGroupConverter,
  createProviderFallbackUserConverter,
  importUsersAndGroups,
  needsProviderFallback,
  stubConvertGroup,
  stubConvertUser,
  type NewGroupRow,
  type NewUserRow,
  type UsersGroupsWriter
} from './users-groups.ts'

const TARGET_ADMIN_GROUP_ID = 'target-admin-group-uuid'
const TARGET_GUEST_GROUP_ID = 'target-guest-group-uuid'

/** Wraps a plain array as the `AsyncIterable<SourceRecord>` the engine consumes, matching how a
 * real `SourceConnector` generator would be read. */
async function* iter<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

/** A writer that records every call it receives, in order, on top of a real (non-DB) uuid-minting
 * implementation — lets a test assert both write order and write content without a database. */
function recordingWriter(): UsersGroupsWriter & { calls: string[] } {
  const base = createDryRunWriter()
  const calls: string[] = []
  return {
    calls,
    async insertGroup(row) {
      calls.push(`insertGroup:${row.name}`)
      return base.insertGroup(row)
    },
    async insertUser(row) {
      calls.push(`insertUser:${row.email}`)
      return base.insertUser(row)
    },
    async insertUserGroup(userId, groupId) {
      calls.push(`insertUserGroup:${userId}:${groupId}`)
      return base.insertUserGroup(userId, groupId)
    },
    async assignUserToSystemGroup(userId, groupId) {
      calls.push(`assignUserToSystemGroup:${userId}:${groupId}`)
      return base.assignUserToSystemGroup(userId, groupId)
    }
  }
}

/** Minimal-but-real converters, standing in for the field-mapping task this task defers to —
 * enough to exercise the actual write path and id-mapping, without claiming to be the real
 * 2.x → 3.0 field mapping (auth/meta/prefs folding, rule conversion, etc). */
const passthroughConvertGroup = (source: { name?: unknown }) =>
  ({ status: 'created', row: { name: String(source.name) } as NewGroupRow }) as const

const passthroughConvertUser = (source: { email?: unknown; name?: unknown }) =>
  ({
    status: 'created',
    row: { email: String(source.email), name: String(source.name) } as NewUserRow
  }) as const

describe('importUsersAndGroups', () => {
  test('writes in the order groups, then users, then userGroups', async () => {
    const writer = recordingWriter()

    await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertGroup: passthroughConvertGroup,
      convertUser: passthroughConvertUser
    })

    assert.equal(writer.calls.length, 3)
    assert.match(writer.calls[0], /^insertGroup:/)
    assert.match(writer.calls[1], /^insertUser:/)
    assert.match(writer.calls[2], /^insertUserGroup:/)
  })

  test('threads source-id -> target-uuid maps through so userGroups resolves the real target ids', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertGroup: passthroughConvertGroup,
      convertUser: passthroughConvertUser
    })

    const [groupRecord] = result.groups.records
    const [userRecord] = result.users.records
    const [membershipRecord] = result.userGroups.records

    assert.equal(membershipRecord.status, 'created')
    // The membership row was written against the *target* uuids minted for the group/user above,
    // not the source integer ids — proving the id maps were actually threaded through.
    assert.ok(groupRecord.targetId)
    assert.ok(userRecord.targetId)
  })

  test('skips a membership row when its group was never created (referential integrity across phases)', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([]), // group 1 never gets created
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertGroup: passthroughConvertGroup,
      convertUser: passthroughConvertUser
    })

    assert.equal(result.userGroups.skipped, 1)
    assert.equal(result.userGroups.created, 0)
    assert.match(result.userGroups.records[0].message ?? '', /group/)
  })

  test('default stub converters flag every group/user record without writing anything', async () => {
    const writer = recordingWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([{ id: 10, email: 'a@example.com', name: 'A' }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer
    })

    assert.equal(result.groups.flagged, 1)
    assert.equal(result.users.flagged, 1)
    assert.equal(writer.calls.length, 0)
    // With neither id map populated, the membership row has nothing to resolve against.
    assert.equal(result.userGroups.skipped, 1)

    // Confirms the exported stubs are in fact what gets used by default.
    assert.equal((await stubConvertGroup({ id: 1 })).status, 'flagged')
    assert.equal((await stubConvertUser({ id: 1 })).status, 'flagged')
  })

  test('a record with a missing/non-integer source id is skipped rather than crashing the phase', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ name: 'No id here' }]),
        users: iter([]),
        userGroups: iter([])
      },
      writer,
      convertGroup: passthroughConvertGroup
    })

    assert.equal(result.groups.skipped, 1)
    assert.equal(result.groups.created, 0)
  })

  test('a writer failure (e.g. a unique-constraint violation) downgrades that record to conflicted, not a thrown import', async () => {
    const writer: UsersGroupsWriter = {
      async insertGroup() {
        throw new Error('duplicate key value violates unique constraint')
      },
      async insertUser() {
        return { id: crypto.randomUUID() }
      },
      async insertUserGroup() {},
      async assignUserToSystemGroup() {}
    }

    const result = await importUsersAndGroups({
      source: {
        groups: iter([{ id: 1, name: 'Editors' }]),
        users: iter([]),
        userGroups: iter([])
      },
      writer,
      convertGroup: passthroughConvertGroup
    })

    assert.equal(result.groups.conflicted, 1)
    assert.match(result.groups.records[0].message ?? '', /unique constraint/)
  })
})

/**
 * Coverage for `needsProviderFallback()` and `createProviderFallbackUserConverter()` (Task 729):
 * unsupported and reconfigured-provider fallback handling.
 */
describe('needsProviderFallback', () => {
  test('local never falls back', () => {
    assert.equal(needsProviderFallback('local'), false)
    assert.equal(needsProviderFallback('local', { local: 'some-uuid' }), false)
  })

  test('any provider with no strategy mapping supplied always falls back, whether or not 3.0 has the module', () => {
    // -> ldap/saml/auth0 are all real 3.0 modules today (Epic #333's territory since this test was
    //    written), but `needsProviderFallback` never special-cases which providers are implemented —
    //    it falls back for anything not named in `strategyMapping`. `providerFallbackReason` is what
    //    branches on implementedness, tested separately above via `createProviderFallbackUserConverter`.
    assert.equal(needsProviderFallback('ldap'), true)
    assert.equal(needsProviderFallback('saml'), true)
    assert.equal(needsProviderFallback('auth0'), true)
  })

  test('a 3.0-implemented provider (github/google/oidc) falls back when unmapped', () => {
    assert.equal(needsProviderFallback('github'), true)
    assert.equal(needsProviderFallback('google'), true)
    assert.equal(needsProviderFallback('oidc'), true)
  })

  test('a 3.0-implemented provider does not fall back once the caller supplies a strategy mapping for it', () => {
    assert.equal(needsProviderFallback('github', { github: 'target-github-strategy-uuid' }), false)
  })

  test('a mapping for a different provider does not exempt this one', () => {
    assert.equal(needsProviderFallback('github', { google: 'target-google-strategy-uuid' }), true)
  })
})

describe('createProviderFallbackUserConverter', () => {
  const LOCAL_STRATEGY_ID = 'local-strategy-uuid'

  test('creates an unsupported-provider (e.g. firebase — a confirmed no-destination 2.x provider) account through the local strategy, mustChangePwd forced true', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 1,
      email: 'Firebase.User@Example.com',
      name: 'Firebase User',
      providerKey: 'firebase'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return // -> type narrowing for the assertions below
    assert.equal(outcome.row.email, 'firebase.user@example.com')
    const authEntry = (outcome.row.auth as any)[LOCAL_STRATEGY_ID]
    assert.equal(authEntry.mustChangePwd, true)
    assert.ok(authEntry.password.startsWith('$2')) // -> a bcrypt hash, not a plaintext/placeholder string
    assert.ok(outcome.providerFallback)
    assert.deepEqual(outcome.providerFallback, {
      email: 'firebase.user@example.com',
      sourceProvider: 'firebase',
      reason: outcome.providerFallback!.reason
    })
    assert.match(outcome.providerFallback!.reason, /no 3\.0-native implementation/)
  })

  test('creates a 3.0-implemented-but-unmapped provider (e.g. ldap) account through the local strategy, with a mapping-specific reason', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 5,
      email: 'Ldap.User@Example.com',
      name: 'LDAP User',
      providerKey: 'ldap'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return // -> type narrowing for the assertions below
    assert.ok(outcome.providerFallback)
    assert.equal(outcome.providerFallback!.sourceProvider, 'ldap')
    assert.match(
      outcome.providerFallback!.reason,
      /is implemented in 3\.0, but no target-strategy mapping was supplied/
    )
  })

  test('creates a github account via fallback when no strategy mapping is supplied, with a mapping-specific reason', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 2,
      email: 'gh@example.com',
      name: 'GH User',
      providerKey: 'github'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.providerFallback?.sourceProvider, 'github')
    assert.match(outcome.providerFallback!.reason, /no target-strategy mapping was supplied/)
  })

  test('does not route a mapped github account through fallback', async () => {
    const convert = createProviderFallbackUserConverter({
      localStrategyId: LOCAL_STRATEGY_ID,
      strategyMapping: { github: 'target-github-strategy-uuid' }
    })

    const outcome = await convert({
      id: 3,
      email: 'gh@example.com',
      name: 'GH User',
      providerKey: 'github'
    })

    assert.equal(outcome.status, 'flagged')
  })

  test("flags rather than converts a local-provider source user — not this converter's job", async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 4,
      email: 'local@example.com',
      name: 'Local User',
      providerKey: 'local'
    })

    assert.equal(outcome.status, 'flagged')
    assert.match((outcome as any).message, /Users\.importLocalUser/)
  })

  test('flags a record with no providerKey rather than guessing', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({ id: 5, email: 'nobody@example.com', name: 'No Provider' })

    assert.equal(outcome.status, 'flagged')
    assert.match((outcome as any).message, /providerKey/)
  })

  test('skips a fallback-eligible record with no email rather than creating an unreachable account', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({ id: 6, name: 'No Email', providerKey: 'ldap' })

    assert.equal(outcome.status, 'skipped')
  })

  test('carries isActive/isVerified, meta and prefs over from the source rather than hardcoding them (Task 1847)', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 7,
      email: 'deactivated@example.com',
      name: 'Deactivated User',
      providerKey: 'ldap',
      isActive: false,
      isVerified: false,
      jobTitle: 'Staff Engineer',
      location: 'Remote',
      timezone: 'Europe/Berlin',
      dateFormat: 'DD/MM/YYYY',
      appearance: 'dark'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    // -> Never silently reopened: a departed employee's deliberately-deactivated 2.x account stays
    //    inactive on import, not one password reset away from a working login.
    assert.equal(outcome.row.isActive, false)
    assert.equal(outcome.row.isVerified, false)
    assert.deepEqual(outcome.row.meta, {
      location: 'Remote',
      jobTitle: 'Staff Engineer',
      pronouns: ''
    })
    assert.deepEqual(outcome.row.prefs, {
      timezone: 'Europe/Berlin',
      dateFormat: 'DD/MM/YYYY',
      timeFormat: '12h',
      appearance: 'dark',
      cvd: 'none'
    })
  })

  test('falls back to isActive: false (never true) and the usual defaults when the source has nothing to give', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 8,
      email: 'bare@example.com',
      name: 'Bare Record',
      providerKey: 'ldap'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.row.isActive, false)
    assert.equal(outcome.row.isVerified, true)
    assert.deepEqual(outcome.row.meta, { location: '', jobTitle: '', pronouns: '' })
    assert.equal((outcome.row.prefs as any).timezone, 'America/New_York')
  })

  test('carries createdAt/updatedAt/lastLoginAt timestamps over from the source', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })
    const createdAt = new Date('2019-03-04T12:00:00.000Z')
    const updatedAt = new Date('2022-06-01T08:30:00.000Z')
    const lastLoginAt = new Date('2023-11-20T17:45:00.000Z')

    const outcome = await convert({
      id: 9,
      email: 'timestamps@example.com',
      name: 'Timestamped User',
      providerKey: 'ldap',
      createdAt,
      updatedAt,
      lastLoginAt
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.deepEqual(outcome.row.createdAt, createdAt)
    assert.deepEqual(outcome.row.updatedAt, updatedAt)
    assert.deepEqual(outcome.row.lastLoginAt, lastLoginAt)
  })

  test('degrades a malformed source timestamp to undefined rather than failing the whole record', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 10,
      email: 'malformed-date@example.com',
      name: 'Malformed Date',
      providerKey: 'ldap',
      createdAt: 'not-a-date'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.row.createdAt, undefined)
  })

  test('end-to-end through importUsersAndGroups: fallback-routed accounts are written and reported in providerFallbacks', async () => {
    const writer = createDryRunWriter()
    const convertUser = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const result = await importUsersAndGroups({
      source: {
        groups: (async function* () {})(),
        users: (async function* () {
          yield { id: 1, email: 'ldap@example.com', name: 'LDAP User', providerKey: 'ldap' }
          yield { id: 2, email: 'local@example.com', name: 'Local User', providerKey: 'local' }
        })(),
        userGroups: (async function* () {})()
      },
      writer,
      convertUser
    })

    assert.equal(result.users.created, 1)
    assert.equal(result.users.flagged, 1)
    assert.equal(result.providerFallbacks.length, 1)
    assert.deepEqual(
      {
        email: result.providerFallbacks[0].email,
        sourceProvider: result.providerFallbacks[0].sourceProvider
      },
      { email: 'ldap@example.com', sourceProvider: 'ldap' }
    )
  })
})

/**
 * Coverage for `createGroupConverter()` (Task 730): group and page-rule schema conversion.
 */
describe('createGroupConverter', () => {
  const convert = createGroupConverter()

  test('skips a system group rather than importing it — 3.0 seeds its own via Groups.init()', async () => {
    const outcome = await convert({
      id: 1,
      name: 'Administrators',
      isSystem: true,
      permissions: ['manage:system'],
      pageRules: []
    })

    assert.equal(outcome.status, 'skipped')
    assert.match((outcome as any).message, /Groups\.init/)
  })

  test('skips a group record with no name', async () => {
    const outcome = await convert({ id: 1, isSystem: false, permissions: [], pageRules: [] })
    assert.equal(outcome.status, 'skipped')
  })

  test('converts deny:true/false to mode DENY/ALLOW, never FORCEALLOW, with fresh ids, synthesized names and sites: []', async () => {
    const outcome = await convert({
      id: 1,
      name: 'Editors',
      isSystem: false,
      permissions: [],
      pageRules: [
        {
          id: '1',
          deny: true,
          match: 'START',
          path: 'private',
          roles: ['read:pages'],
          locales: []
        },
        { id: '2', deny: false, match: 'EXACT', path: '', roles: ['write:pages'], locales: ['en'] }
      ]
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    const rules = outcome.row.rules as any[]
    assert.equal(rules.length, 2)

    assert.equal(rules[0].mode, 'DENY')
    assert.equal(rules[0].match, 'START')
    assert.equal(rules[0].path, 'private')
    assert.deepEqual(rules[0].roles, ['read:pages'])
    assert.deepEqual(rules[0].sites, [])
    assert.equal(rules[0].name, 'Imported Rule 1: START private')
    assert.notEqual(rules[0].id, '1') // -> fresh id, not the 2.x source id carried forward

    assert.equal(rules[1].mode, 'ALLOW')
    assert.deepEqual(rules[1].locales, ['en'])
    assert.equal(rules[1].name, 'Imported Rule 2') // -> empty path falls back to the generic label

    for (const rule of rules) {
      assert.notEqual(rule.mode, 'FORCEALLOW')
    }
  })

  test("converts an export-bundle source's integer-valued deny (0/1) the same as a real boolean (OpenProject #1850)", async () => {
    // -> MySQL/MariaDB/SQLite via the export bundle connector represent 2.x boolean columns as JSON
    //    integers (0/1) — convertPageRule() must widen deny's coercion the same as isSystem's, or
    //    every imported page rule is dropped as malformed.
    const outcome = await convert({
      id: 1,
      name: 'Editors',
      isSystem: 0,
      permissions: [],
      pageRules: [
        { id: '1', deny: 1, match: 'START', path: 'private', roles: ['read:pages'], locales: [] },
        { id: '2', deny: 0, match: 'EXACT', path: '', roles: ['write:pages'], locales: ['en'] }
      ]
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    const rules = outcome.row.rules as any[]
    assert.equal(rules.length, 2)
    assert.equal(rules[0].mode, 'DENY')
    assert.equal(rules[1].mode, 'ALLOW')
  })

  test('drops a malformed page rule (missing deny, or an unsupported match value) instead of failing the group', async () => {
    const outcome = await convert({
      id: 1,
      name: 'Editors',
      isSystem: false,
      permissions: [],
      pageRules: [
        { id: '1', match: 'START', path: '', roles: [], locales: [] }, // -> no `deny`
        { id: '2', deny: false, match: 'TAGALL', path: '', roles: [], locales: [] }, // -> no 2.x source
        { id: '3', deny: true, match: 'END', path: 'blog', roles: [], locales: [] } // -> valid
      ]
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal((outcome.row.rules as any[]).length, 1)
    assert.match(outcome.message ?? '', /2 malformed page rule/)
  })

  test('keeps only the closed seven-name global permissions, dropping page-rule-effectiveness-only entries', async () => {
    const outcome = await convert({
      id: 1,
      name: 'Editors',
      isSystem: false,
      permissions: ['manage:navigation', 'read:pages', 'write:pages', 'manage:system'],
      pageRules: []
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.deepEqual(outcome.row.permissions, ['manage:navigation', 'manage:system'])
    assert.match(outcome.message ?? '', /dropped 2 permission/)
  })

  test('a clean conversion (nothing dropped) has no message', async () => {
    const outcome = await convert({
      id: 1,
      name: 'Editors',
      isSystem: false,
      permissions: ['manage:navigation'],
      pageRules: [{ id: '1', deny: false, match: 'START', path: '', roles: [], locales: [] }]
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.message, undefined)
  })

  test('end-to-end through importUsersAndGroups: a converted group is written and its rule shape survives the writer round-trip', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: (async function* () {
          yield {
            id: 1,
            name: 'Editors',
            isSystem: false,
            permissions: ['manage:navigation'],
            pageRules: [
              {
                id: '1',
                deny: true,
                match: 'START',
                path: 'blog',
                roles: ['read:pages'],
                locales: []
              }
            ]
          }
        })(),
        users: (async function* () {})(),
        userGroups: (async function* () {})()
      },
      writer,
      convertGroup: createGroupConverter()
    })

    assert.equal(result.groups.created, 1)
    assert.equal(result.groups.records[0].status, 'created')
    assert.ok(result.groups.records[0].targetId)
  })
})

/**
 * Coverage for `createDrizzleWriter()`'s group-write path (Task 730): groups are written through
 * `WIKI.models.groups.createGroupFromImport()` rather than a raw `db.insert(groupsTable)`.
 */
describe('createDrizzleWriter insertGroup', () => {
  let restoreWiki: (() => void) | undefined

  afterEach(() => {
    restoreWiki?.()
    restoreWiki = undefined
  })

  test('delegates to WIKI.models.groups.createGroupFromImport rather than inserting the row directly', async () => {
    const previous = (globalThis as any).WIKI
    const calls: any[] = []
    ;(globalThis as any).WIKI = {
      models: {
        groups: {
          async createGroupFromImport(input: any) {
            calls.push(input)
            return 'model-written-group-uuid'
          }
        }
      }
    }
    restoreWiki = () => {
      ;(globalThis as any).WIKI = previous
    }

    // `db` is never touched by insertGroup on this task's writer, so a stub that throws on any use
    // proves the raw-insert path is genuinely gone rather than merely unused by this particular row.
    const explodingDb = {
      insert() {
        throw new Error('insertGroup must not call db.insert directly — see Task 730')
      }
    } as any

    const writer = createDrizzleWriter(explodingDb)
    const result = await writer.insertGroup({
      name: 'Editors',
      permissions: ['manage:navigation'],
      rules: []
    } as NewGroupRow)

    assert.equal(result.id, 'model-written-group-uuid')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { name: 'Editors', permissions: ['manage:navigation'], rules: [] })
  })
})

/**
 * Coverage for Task 731: system-row exclusion and admin/guest membership remapping.
 */
describe('system-row exclusion (Task 731)', () => {
  test('a source group flagged isSystem is skipped without ever calling convertGroup', async () => {
    let convertCalls = 0
    const convertGroup = (source: { name?: unknown }) => {
      convertCalls++
      return { status: 'created', row: { name: String(source.name) } as NewGroupRow } as const
    }

    const result = await importUsersAndGroups({
      source: {
        groups: iter([
          { id: 1, name: 'Administrators', isSystem: true },
          { id: 3, name: 'Editors', isSystem: false }
        ]),
        users: iter([]),
        userGroups: iter([])
      },
      writer: createDryRunWriter(),
      convertGroup
    })

    assert.equal(result.groups.skipped, 1)
    assert.equal(result.groups.created, 1)
    assert.equal(convertCalls, 1) // -> the system row never reached convertGroup at all
    assert.match(result.groups.records[0].message ?? '', /system group/)
  })

  test("an export-bundle source's integer-valued isSystem (1) is still skipped (OpenProject #1850)", async () => {
    // -> MySQL/MariaDB/SQLite via the export bundle connector represent 2.x boolean columns as JSON
    //    integers (0/1), not real booleans — readSourceBoolean() must widen to accept that
    //    representation, or a source's system Administrators/Guests rows import as duplicates.
    let convertCalls = 0
    const convertGroup = (source: { name?: unknown }) => {
      convertCalls++
      return { status: 'created', row: { name: String(source.name) } as NewGroupRow } as const
    }

    const result = await importUsersAndGroups({
      source: {
        groups: iter([
          { id: 1, name: 'Administrators', isSystem: 1 },
          { id: 3, name: 'Editors', isSystem: 0 }
        ]),
        users: iter([]),
        userGroups: iter([])
      },
      writer: createDryRunWriter(),
      convertGroup
    })

    assert.equal(result.groups.skipped, 1)
    assert.equal(result.groups.created, 1)
    assert.equal(convertCalls, 1) // -> the system row never reached convertGroup at all
    assert.match(result.groups.records[0].message ?? '', /system group/)
  })

  test('a source user flagged isSystem is skipped without ever calling convertUser', async () => {
    let convertCalls = 0
    const convertUser = (source: { email?: unknown; name?: unknown }) => {
      convertCalls++
      return {
        status: 'created',
        row: { email: String(source.email), name: String(source.name) } as NewUserRow
      } as const
    }

    const result = await importUsersAndGroups({
      source: {
        groups: iter([]),
        users: iter([
          { id: 1, email: 'admin@example.com', name: 'Administrator', isSystem: true },
          { id: 2, email: 'guest@example.com', name: 'Guest', isSystem: true },
          { id: 10, email: 'alice@example.com', name: 'Alice', isSystem: false }
        ]),
        userGroups: iter([])
      },
      writer: createDryRunWriter(),
      convertUser
    })

    assert.equal(result.users.skipped, 2)
    assert.equal(result.users.created, 1)
    assert.equal(convertCalls, 1) // -> neither system row reached convertUser at all
    for (const rec of result.users.records) {
      if (rec.status === 'skipped') {
        assert.match(rec.message ?? '', /system user/)
      }
    }
  })

  test(
    'an ordinary user who was only in the source Administrators group ends up assigned to the ' +
      "target's real admin group id",
    async () => {
      const writer = recordingWriter()

      const result = await importUsersAndGroups({
        source: {
          // The source Administrators (id 1) and Guests (id 2) groups themselves are never even
          // part of this feed — a real SourceConnector wouldn't yield them once isSystem rows are
          // excluded upstream, and the engine must not depend on seeing them to do the remap.
          groups: iter([]),
          users: iter([{ id: 10, email: 'alice@example.com', name: 'Alice', isSystem: false }]),
          userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
        },
        writer,
        convertUser: passthroughConvertUser,
        systemGroupIds: { admin: TARGET_ADMIN_GROUP_ID, guest: TARGET_GUEST_GROUP_ID }
      })

      assert.equal(result.userGroups.created, 1)
      assert.equal(result.userGroups.skipped, 0)
      assert.equal(result.userGroups.records[0].targetId, TARGET_ADMIN_GROUP_ID)
      assert.match(result.userGroups.records[0].message ?? '', /remapped/)

      // The remap must go through assignUserToSystemGroup (-> Groups.assignUserToGroup on the real
      // writer), never a raw insertUserGroup call, for this membership.
      assert.ok(writer.calls.some((call) => call.startsWith('assignUserToSystemGroup:')))
      assert.ok(!writer.calls.some((call) => call.startsWith('insertUserGroup:')))
    }
  )

  test('an ordinary user in the source Guests group is remapped onto the target guest group id', async () => {
    const writer = recordingWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([]),
        users: iter([{ id: 11, email: 'bob@example.com', name: 'Bob', isSystem: false }]),
        userGroups: iter([{ id: 101, userId: 11, groupId: 2 }])
      },
      writer,
      convertUser: passthroughConvertUser,
      systemGroupIds: { admin: TARGET_ADMIN_GROUP_ID, guest: TARGET_GUEST_GROUP_ID }
    })

    assert.equal(result.userGroups.created, 1)
    assert.equal(result.userGroups.records[0].targetId, TARGET_GUEST_GROUP_ID)
  })

  test('without systemGroupIds supplied, a membership pointing at the source system group is still just skipped (pre-731 behavior)', async () => {
    const writer = createDryRunWriter()

    const result = await importUsersAndGroups({
      source: {
        groups: iter([]),
        users: iter([{ id: 10, email: 'alice@example.com', name: 'Alice', isSystem: false }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertUser: passthroughConvertUser
      // -> no systemGroupIds
    })

    assert.equal(result.userGroups.skipped, 1)
    assert.equal(result.userGroups.created, 0)
  })

  test('an ordinary group with the same numeric id as a source system group is unaffected — real resolution wins over the remap fallback', async () => {
    const writer = recordingWriter()

    const result = await importUsersAndGroups({
      source: {
        // Group id 1 here is a genuine, non-system, created group — not the source's Administrators.
        groups: iter([{ id: 1, name: 'Editors', isSystem: false }]),
        users: iter([{ id: 10, email: 'alice@example.com', name: 'Alice', isSystem: false }]),
        userGroups: iter([{ id: 100, userId: 10, groupId: 1 }])
      },
      writer,
      convertGroup: passthroughConvertGroup,
      convertUser: passthroughConvertUser,
      systemGroupIds: { admin: TARGET_ADMIN_GROUP_ID, guest: TARGET_GUEST_GROUP_ID }
    })

    assert.equal(result.userGroups.created, 1)
    assert.notEqual(result.userGroups.records[0].targetId, TARGET_ADMIN_GROUP_ID)
    assert.ok(writer.calls.some((call) => call.startsWith('insertUserGroup:')))
    assert.ok(!writer.calls.some((call) => call.startsWith('assignUserToSystemGroup:')))
  })

  test('createDrizzleWriter.assignUserToSystemGroup delegates to Groups.assignUserToGroup(groupId, userId)', async () => {
    const previous = (globalThis as any).WIKI
    const calls: any[] = []
    ;(globalThis as any).WIKI = {
      models: {
        groups: {
          async assignUserToGroup(groupId: string, userId: string) {
            calls.push({ groupId, userId })
            return true
          }
        }
      }
    }
    try {
      const explodingDb = {
        insert() {
          throw new Error('assignUserToSystemGroup must not call db.insert directly')
        }
      } as any
      const writer = createDrizzleWriter(explodingDb)

      await writer.assignUserToSystemGroup('user-uuid', 'group-uuid')

      assert.deepEqual(calls, [{ groupId: 'group-uuid', userId: 'user-uuid' }])
    } finally {
      ;(globalThis as any).WIKI = previous
    }
  })
})
