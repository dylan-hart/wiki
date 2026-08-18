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
      async insertUserGroup() {}
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

  test('an unimplemented 2.x provider (no 3.0 module at all) always falls back', () => {
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

  test('creates an unsupported-provider (e.g. ldap) account through the local strategy, mustChangePwd forced true', async () => {
    const convert = createProviderFallbackUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

    const outcome = await convert({
      id: 1,
      email: 'Ldap.User@Example.com',
      name: 'LDAP User',
      providerKey: 'ldap'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return // -> type narrowing for the assertions below
    assert.equal(outcome.row.email, 'ldap.user@example.com')
    const authEntry = (outcome.row.auth as any)[LOCAL_STRATEGY_ID]
    assert.equal(authEntry.mustChangePwd, true)
    assert.ok(authEntry.password.startsWith('$2')) // -> a bcrypt hash, not a plaintext/placeholder string
    assert.ok(outcome.providerFallback)
    assert.deepEqual(outcome.providerFallback, {
      email: 'ldap.user@example.com',
      sourceProvider: 'ldap',
      reason: outcome.providerFallback!.reason
    })
    assert.match(outcome.providerFallback!.reason, /no 3\.0-native implementation/)
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
