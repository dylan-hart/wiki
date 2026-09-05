import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  composeUserConverters,
  createDrizzleWriter,
  createDryRunWriter,
  createGroupConverter,
  createLocalUserConverter,
  createGroupImporter,
  createProviderFallbackUserConverter,
  createUserGroupImporter,
  createUserImporter,
  deriveUserGroupsFromEmbeddedGroups,
  needsProviderFallback,
  type EntityImportSummary,
  type GroupConverter,
  type NewGroupRow,
  type NewUserRow,
  type ProviderFallbackFlag,
  type SystemGroupIds,
  type UserConverter,
  type UsersGroupsWriter
} from './users-groups.ts'
import type { SourceRecord } from '../connector.ts'
import { iterate as iter } from '../../test/migrationFixtures.ts'
import { installTestWiki } from '../../test/mocks.ts'

const TARGET_ADMIN_GROUP_ID = 'target-admin-group-uuid'
const TARGET_GUEST_GROUP_ID = 'target-guest-group-uuid'

/** Wraps a plain array as the `AsyncIterable<SourceRecord>` the engine consumes, matching how a
 * real `SourceConnector` generator would be read. */
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

/** A converter that writes nothing, standing in for a caller that supplied no real one. */
const flagEverythingGroupConverter: GroupConverter = () => ({
  status: 'flagged',
  message: 'no group converter supplied'
})

const flagEverythingUserConverter: UserConverter = () => ({
  status: 'flagged',
  message: 'no user converter supplied'
})

interface UsersGroupsRun {
  groups: EntityImportSummary
  users: EntityImportSummary
  userGroups: EntityImportSummary
  providerFallbacks: ProviderFallbackFlag[]
}

/** Drives the three per-record importers in the order `phases/users.ts` drives them — groups, then
 * users, then `userGroups`, each fully drained before the next starts, since a membership can only
 * resolve once both id maps are built — and folds the run's three summaries together, so a test can
 * assert against a whole run rather than call-by-call. */
async function runUsersGroupsImport(input: {
  source: {
    groups: AsyncIterable<SourceRecord>
    users: AsyncIterable<SourceRecord>
    userGroups: AsyncIterable<SourceRecord>
  }
  writer: UsersGroupsWriter
  convertGroup?: GroupConverter
  convertUser?: UserConverter
  systemGroupIds?: SystemGroupIds
}): Promise<UsersGroupsRun> {
  const groupImporter = createGroupImporter(
    input.convertGroup ?? flagEverythingGroupConverter,
    input.writer
  )
  for await (const sourceRecord of input.source.groups) {
    await groupImporter.importOne(sourceRecord)
  }

  const userImporter = createUserImporter(
    input.convertUser ?? flagEverythingUserConverter,
    input.writer
  )
  for await (const sourceRecord of input.source.users) {
    await userImporter.importOne(sourceRecord)
  }

  const userGroupImporter = createUserGroupImporter(
    userImporter.idMap,
    groupImporter.idMap,
    input.writer,
    input.systemGroupIds
  )
  for await (const sourceRecord of input.source.userGroups) {
    await userGroupImporter.importOne(sourceRecord)
  }

  return {
    groups: groupImporter.summary,
    users: userImporter.summary,
    userGroups: userGroupImporter.summary,
    providerFallbacks: userImporter.providerFallbacks
  }
}

describe('the three importers driven in write order', () => {
  test('writes in the order groups, then users, then userGroups', async () => {
    const writer = recordingWriter()

    await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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

  test('a converter that flags every record writes nothing at all', async () => {
    const writer = recordingWriter()

    const result = await runUsersGroupsImport({
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
  })

  test('a record with a missing/non-integer source id is skipped rather than crashing the phase', async () => {
    const writer = createDryRunWriter()

    const result = await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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
  })

  test('every non-local provider falls back, whether or not 3.0 has the module', () => {
    // -> ldap/saml/auth0 are all real 3.0 modules today (Epic #333's territory since this test was
    //    written), but `needsProviderFallback` never special-cases which providers are implemented.
    //    `providerFallbackReason` is what branches on implementedness, tested separately via
    //    `createProviderFallbackUserConverter`.
    assert.equal(needsProviderFallback('ldap'), true)
    assert.equal(needsProviderFallback('saml'), true)
    assert.equal(needsProviderFallback('auth0'), true)
    assert.equal(needsProviderFallback('github'), true)
    assert.equal(needsProviderFallback('google'), true)
    assert.equal(needsProviderFallback('oidc'), true)
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

  test('preserves the original providerKey as visibility-only metadata on the local auth entry (Task 2558)', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 11,
      email: 'saml.user@example.com',
      name: 'SAML User',
      providerKey: 'saml'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    const authEntry = (outcome.row.auth as any)[LOCAL_STRATEGY_ID]
    assert.equal(authEntry.migratedFallbackProvider, 'saml')
  })

  test('creates a 3.0-implemented provider (e.g. ldap) account through the local strategy, with an implemented-but-unresolvable reason', async () => {
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
    assert.match(outcome.providerFallback!.reason, /is implemented in 3\.0/)
  })

  test('creates a github account via fallback, with an implemented-but-unresolvable reason', async () => {
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
    assert.match(outcome.providerFallback!.reason, /is implemented in 3\.0/)
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

  test('end-to-end through all three importers: fallback-routed accounts are written and reported in providerFallbacks', async () => {
    const writer = createDryRunWriter()
    const convertUser = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const result = await runUsersGroupsImport({
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

  test('end-to-end through all three importers: a converted group is written and its rule shape survives the writer round-trip', async () => {
    const writer = createDryRunWriter()

    const result = await runUsersGroupsImport({
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
    const calls: any[] = []
    const handle = installTestWiki({
      models: {
        groups: {
          async createGroupFromImport(input: any) {
            calls.push(input)
            return 'model-written-group-uuid'
          }
        }
      }
    })
    restoreWiki = () => handle.restore()

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

    const result = await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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

      const result = await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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

    const result = await runUsersGroupsImport({
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
    const calls: any[] = []
    const handle = installTestWiki({
      models: {
        groups: {
          async assignUserToGroup(groupId: string, userId: string) {
            calls.push({ groupId, userId })
            return true
          }
        }
      }
    })
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
      handle.restore()
    }
  })
})

/**
 * Coverage for the Task 12 extraction: `createGroupImporter()`/`createUserImporter()`/
 * `createUserGroupImporter()` expose a per-record `importOne()` that Task 14's phase wiring drives
 * one source record at a time, instead of only ever being handed a whole iterable up front (as
 * `phases/users.ts` drives them).
 */
describe('createGroupImporter / createUserGroupImporter (Task 12 extraction)', () => {
  test('createGroupImporter accumulates idMap across multiple importOne() calls', async () => {
    const writer = createDryRunWriter()
    const importer = createGroupImporter(passthroughConvertGroup, writer)

    await importer.importOne({ id: 1, name: 'Editors' })
    await importer.importOne({ id: 2, name: 'Reviewers' })

    assert.equal(importer.idMap.size, 2)
    assert.ok(importer.idMap.has(1))
    assert.ok(importer.idMap.has(2))
    assert.notEqual(importer.idMap.get(1), importer.idMap.get(2))
    assert.equal(importer.summary.created, 2)
    assert.equal(importer.summary.records.length, 2)
  })

  test('createUserGroupImporter uses the exact idMap instances passed in, not copies', async () => {
    const userIdMap = new Map<number, string>()
    const groupIdMap = new Map<number, string>()
    const writer = createDryRunWriter()

    const importer = createUserGroupImporter(userIdMap, groupIdMap, writer)

    // Mutate the maps AFTER construction, before importOne() -- proves the importer holds a live
    // reference to the same Map instances rather than a snapshot taken at construction time, which
    // is exactly what Task 14's phase wiring depends on (groups/users importers mutate these same
    // maps as their own phases run, interleaved with this importer's own construction).
    userIdMap.set(10, 'target-user-uuid')
    groupIdMap.set(1, 'target-group-uuid')

    await importer.importOne({ id: 100, userId: 10, groupId: 1 })

    assert.equal(importer.summary.created, 1)
    assert.equal(importer.summary.records[0].targetId, 'target-group-uuid')
  })
})

/**
 * Coverage for the Task 14 review fix: `createGroupImporter`/`createUserImporter`/
 * `createUserGroupImporter`'s `importOne()` now RETURNS the exact `RecordStatus` it recorded onto
 * `summary`, rather than discarding it (`Promise<void>` -> `Promise<RecordStatus>`) — this is what
 * lets a caller driving `importOne()` directly (`phases/users.ts`) route its own `WriteRecorder` call
 * to match the real per-record outcome, instead of unconditionally treating every processed record as
 * a create.
 */
describe('importOne() return value (Task 14 review fix)', () => {
  test("createGroupImporter's importOne() returns 'created' for a real conversion", async () => {
    const importer = createGroupImporter(passthroughConvertGroup, createDryRunWriter())
    assert.equal(await importer.importOne({ id: 1, name: 'Editors' }), 'created')
  })

  test("createGroupImporter's importOne() returns 'skipped' for a system row, without calling convert", async () => {
    const importer = createGroupImporter(passthroughConvertGroup, createDryRunWriter())
    assert.equal(
      await importer.importOne({ id: 1, name: 'Administrators', isSystem: true }),
      'skipped'
    )
  })

  test("createGroupImporter's importOne() returns the converter's own status for a non-created outcome", async () => {
    const importer = createGroupImporter(flagEverythingGroupConverter, createDryRunWriter())
    assert.equal(await importer.importOne({ id: 1, name: 'Editors' }), 'flagged')
  })

  test("createGroupImporter's importOne() returns 'conflicted' when the writer throws", async () => {
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
    const importer = createGroupImporter(passthroughConvertGroup, writer)
    assert.equal(await importer.importOne({ id: 1, name: 'Editors' }), 'conflicted')
  })

  test("createUserImporter's importOne() returns 'created' for a real conversion", async () => {
    const importer = createUserImporter(passthroughConvertUser, createDryRunWriter())
    assert.equal(await importer.importOne({ id: 10, email: 'a@example.com', name: 'A' }), 'created')
  })

  test("createUserImporter's importOne() returns the converter's own status for a non-created outcome", async () => {
    const importer = createUserImporter(flagEverythingUserConverter, createDryRunWriter())
    assert.equal(await importer.importOne({ id: 10, email: 'a@example.com', name: 'A' }), 'flagged')
  })

  test("createUserGroupImporter's importOne() returns 'created' when both ids resolve, 'skipped' when one doesn't", async () => {
    const userIdMap = new Map<number, string>([[10, 'target-user-uuid']])
    const groupIdMap = new Map<number, string>([[1, 'target-group-uuid']])
    const importer = createUserGroupImporter(userIdMap, groupIdMap, createDryRunWriter())

    assert.equal(await importer.importOne({ id: 100, userId: 10, groupId: 1 }), 'created')
    assert.equal(await importer.importOne({ id: 101, userId: 10, groupId: 999 }), 'skipped')
  })
})

/**
 * Coverage for `deriveUserGroupsFromEmbeddedGroups()` (Task 14) — re-expands
 * `PostgresSourceConnector.users()`'s embedded `groups: [{id, name}]` shape (Task 8) into the flat
 * `{userId, groupId}` records `createUserGroupImporter()` consumes.
 */
describe('deriveUserGroupsFromEmbeddedGroups', () => {
  test('yields one pair per embedded group, in source order', async () => {
    const users = (async function* (): AsyncGenerator<SourceRecord> {
      yield {
        id: 1,
        groups: [
          { id: 10, name: 'A' },
          { id: 11, name: 'B' }
        ]
      }
      yield { id: 2, groups: [] }
    })()

    const pairs: SourceRecord[] = []
    for await (const pair of deriveUserGroupsFromEmbeddedGroups(users)) {
      pairs.push(pair)
    }

    assert.deepEqual(pairs, [
      { userId: 1, groupId: 10 },
      { userId: 1, groupId: 11 }
    ])
  })

  test('yields nothing for a user whose groups field is missing or not an array', async () => {
    const users = (async function* (): AsyncGenerator<SourceRecord> {
      yield { id: 1 }
      yield { id: 2, groups: null }
    })()

    const pairs: SourceRecord[] = []
    for await (const pair of deriveUserGroupsFromEmbeddedGroups(users)) {
      pairs.push(pair)
    }

    assert.deepEqual(pairs, [])
  })

  test('skips a malformed embedded group entry (not an object, or missing id) rather than throwing', async () => {
    const users = (async function* (): AsyncGenerator<SourceRecord> {
      yield { id: 1, groups: [{ id: 10, name: 'A' }, null, { name: 'no id' }, 'not-an-object'] }
    })()

    const pairs: SourceRecord[] = []
    for await (const pair of deriveUserGroupsFromEmbeddedGroups(users)) {
      pairs.push(pair)
    }

    assert.deepEqual(pairs, [{ userId: 1, groupId: 10 }])
  })
})

describe('createLocalUserConverter', () => {
  const LOCAL_STRATEGY_ID = 'local-uuid'
  const convert = createLocalUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

  test('copies the source bcrypt hash verbatim', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      providerKey: 'local'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    const authEntry = (outcome.row.auth as any)[LOCAL_STRATEGY_ID]
    assert.equal(authEntry.password, '$2a$12$fakehash')
  })

  test('never writes migratedFallbackProvider — a genuine local-provider source user has no foreign providerKey to record (Task 2558)', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      providerKey: 'local'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    const authEntry = (outcome.row.auth as any)[LOCAL_STRATEGY_ID]
    assert.equal('migratedFallbackProvider' in authEntry, false)
  })

  test('flags a local user with no password hash to carry over, rather than minting one', async () => {
    const outcome = await convert({ email: 'a@b.com', name: 'A', providerKey: 'local' })

    assert.equal(outcome.status, 'flagged')
    assert.match((outcome as any).message, /password hash/)
  })

  test('skips a record with no email address', async () => {
    const outcome = await convert({ name: 'A', password: '$2a$12$fakehash', providerKey: 'local' })

    assert.equal(outcome.status, 'skipped')
    assert.match((outcome as any).message, /email/)
  })

  test('lowercases the email and falls back to it for name when the source has none', async () => {
    const outcome = await convert({ email: 'Mixed.Case@Example.com', password: '$2a$12$fakehash' })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.row.email, 'mixed.case@example.com')
    assert.equal(outcome.row.name, 'mixed.case@example.com')
  })

  test('widens mustChangePwd/isActive/isVerified to accept an export-bundle integer 0/1 (OpenProject #1845/#1850)', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      mustChangePwd: 1,
      isActive: 1,
      isVerified: 0
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal((outcome.row.auth as any)[LOCAL_STRATEGY_ID].mustChangePwd, true)
    assert.equal(outcome.row.isActive, true)
    assert.equal(outcome.row.isVerified, false)
  })

  test('degrades a malformed source timestamp to undefined rather than failing the whole record', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      createdAt: 'not-a-date'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.row.createdAt, undefined)
  })

  test('carries an ISO-string createdAt over (export-bundle connector shape) same as a real Date', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      createdAt: '2020-01-02T03:04:05.000Z'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.deepEqual(outcome.row.createdAt, new Date('2020-01-02T03:04:05.000Z'))
  })
})

describe('composeUserConverters', () => {
  test("routes a 'local' providerKey to the local converter", async () => {
    let localCalls = 0
    let fallbackCalls = 0
    const local = (() => {
      localCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const fallback = (() => {
      fallbackCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const convert = composeUserConverters(local, fallback)

    await convert({ providerKey: 'local' })

    assert.equal(localCalls, 1)
    assert.equal(fallbackCalls, 0)
  })

  test('routes every other providerKey to the fallback converter', async () => {
    let localCalls = 0
    let fallbackCalls = 0
    const local = (() => {
      localCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const fallback = (() => {
      fallbackCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const convert = composeUserConverters(local, fallback)

    await convert({ providerKey: 'github' })
    await convert({}) // -> no providerKey at all also routes to fallback, not local

    assert.equal(localCalls, 0)
    assert.equal(fallbackCalls, 2)
  })
})
