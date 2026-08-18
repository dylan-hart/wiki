import assert from 'node:assert/strict'
import path from 'node:path'
import { before, describe, test } from 'node:test'
import {
  buildAllowedEmailRegex,
  createAuthenticationMapperState,
  mapAuthenticationRow,
  mapAuthenticationRows,
  remapAutoEnrollGroups,
  type SourceAuthenticationRow
} from './authentication.ts'

/**
 * `mapAuthenticationRow(s)` (task 765) tests.
 *
 * The resolver under test is the *real* `WIKI.models.authentication` singleton, not a hand-rolled
 * fake — per the task description ("going through `Authentication.buildConfig`/`validateConfig` ...
 * against each module's `definition.yml` props"), so this suite boots the minimal slice of `WIKI`
 * that `getModule`/`buildConfig`/`validateConfig` actually touch: `WIKI.data.authentication`,
 * populated by `refreshStrategiesFromDisk()` reading the real
 * `backend/modules/authentication/*\/definition.yml` files straight off disk. None of the three
 * methods this mapper calls touches `WIKI.db`, so this needs no database — see `worker.ts`'s own
 * minimal-`WIKI` pattern for the precedent this mirrors.
 */

before(async () => {
  ;(globalThis as any).WIKI = {
    SERVERPATH: path.join(import.meta.dirname, '..', '..'),
    data: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  }
  const { authentication } = await import('../../models/authentication.ts')
  await authentication.refreshStrategiesFromDisk()
  assert.ok(
    (globalThis as any).WIKI.data.authentication?.length > 0,
    'refreshStrategiesFromDisk should have loaded the real on-disk module definitions'
  )
})

function baseRow(overrides: Partial<SourceAuthenticationRow> = {}): SourceAuthenticationRow {
  return {
    key: 'local',
    isEnabled: true,
    config: {},
    selfRegistration: false,
    domainWhitelist: [],
    autoEnrollGroups: [],
    strategyKey: 'local',
    displayName: '',
    ...overrides
  }
}

async function resolver() {
  return (await import('../../models/authentication.ts')).authentication
}

describe('buildAllowedEmailRegex', () => {
  test('empty/absent domainWhitelist compiles to the empty string (no restriction)', () => {
    assert.equal(buildAllowedEmailRegex([]), '')
    assert.equal(buildAllowedEmailRegex(undefined), '')
    assert.equal(buildAllowedEmailRegex({ v: [] }), '')
  })

  test('compiles an anchored, escaped, case-folded alternation and accepts the wrapped {v:[...]} shape', () => {
    const regex = buildAllowedEmailRegex({ v: ['Example.com', 'foo.org'] })
    assert.equal(regex, '^[^@]+@(example\\.com|foo\\.org)$')
    const re = new RegExp(regex)
    assert.ok(re.test('user@example.com'))
    assert.ok(re.test('user@foo.org'))
  })

  test('accepts the bare-array (export-bundle) shape identically to the wrapped shape', () => {
    assert.equal(
      buildAllowedEmailRegex(['example.com']),
      buildAllowedEmailRegex({ v: ['example.com'] })
    )
  })

  test('is an EXACT domain match, not a suffix/subdomain match — mirrors 2.x _.includes(domainWhitelist, lastSegment)', () => {
    const re = new RegExp(buildAllowedEmailRegex(['example.com']))
    assert.ok(re.test('user@example.com'))
    assert.equal(re.test('user@sub.example.com'), false)
    assert.equal(re.test('user@notexample.com'), false)
  })

  test('the trailing $ anchor is load-bearing: without it, a domain with a malicious suffix would pass', () => {
    const regex = buildAllowedEmailRegex(['example.com'])
    const unanchoredAtEnd = new RegExp(regex.replace(/\$$/, ''))
    // -> Exactly the case the trailing $ exists to prevent: users.ts's `new RegExp(pattern).test(email)`
    //    has no anchoring of its own, so a pattern missing $ would accept "example.com" as a mere
    //    prefix of the actual domain rather than requiring it to be the whole domain.
    assert.ok(unanchoredAtEnd.test('user@example.com.evil.org'))
    assert.equal(new RegExp(regex).test('user@example.com.evil.org'), false)
  })
})

describe('remapAutoEnrollGroups', () => {
  test('remaps known ids and silently drops unknown ones', () => {
    const groupIdMap = new Map([
      [5, 'uuid-a'],
      [9, 'uuid-b']
    ])
    assert.deepEqual(remapAutoEnrollGroups({ v: [5, 9, 42] }, groupIdMap), ['uuid-a', 'uuid-b'])
    assert.deepEqual(remapAutoEnrollGroups([5, 9, 42], groupIdMap), ['uuid-a', 'uuid-b'])
  })

  test('non-array input maps to an empty array rather than throwing', () => {
    assert.deepEqual(remapAutoEnrollGroups(undefined, new Map()), [])
    assert.deepEqual(remapAutoEnrollGroups({ v: null }, new Map()), [])
  })
})

describe('mapAuthenticationRow', () => {
  test('local row: config always {} in, fully-defaulted config out, selfRegistration -> registration', async () => {
    const result = mapAuthenticationRow(
      baseRow({ selfRegistration: true, displayName: 'Local Database' }),
      {
        resolver: await resolver()
      }
    )
    assert.equal(result.status, 'created')
    assert.equal(result.row!.module, 'local')
    assert.equal(result.row!.registration, true)
    assert.equal(result.row!.allowedEmailRegex, '')
    assert.deepEqual(result.row!.config, {
      enforceTfa: false,
      emailValidation: true,
      allowForgotPassword: true
    })
  })

  test('github row: useEnterprise+enterpriseDomain collapse into enterpriseHost', async () => {
    const result = mapAuthenticationRow(
      baseRow({
        key: 'github',
        strategyKey: 'github',
        displayName: 'GitHub',
        config: {
          clientId: 'abc',
          clientSecret: 'secret',
          useEnterprise: true,
          enterpriseDomain: 'github.example.com'
        }
      }),
      { resolver: await resolver() }
    )
    assert.equal(result.status, 'created')
    assert.deepEqual(result.row!.config, {
      clientId: 'abc',
      clientSecret: 'secret',
      enterpriseHost: 'github.example.com',
      allowedOrganization: ''
    })
  })

  test('github row: useEnterprise false does not synthesize enterpriseHost', async () => {
    const result = mapAuthenticationRow(
      baseRow({
        key: 'github',
        strategyKey: 'github',
        config: {
          clientId: 'abc',
          clientSecret: 'secret',
          useEnterprise: false,
          enterpriseDomain: 'ignored.example.com'
        }
      }),
      { resolver: await resolver() }
    )
    assert.equal(result.status, 'created')
    assert.equal((result.row!.config as Record<string, unknown>).enterpriseHost, '')
  })

  test('unsupported module: no 3.0 definition.yml -> unsupported, no row', async () => {
    const result = mapAuthenticationRow(baseRow({ key: 'ldap', strategyKey: 'ldap' }), {
      resolver: await resolver()
    })
    assert.equal(result.status, 'unsupported')
    assert.equal(result.module, 'ldap')
    assert.ok(result.message?.includes('ldap'))
    assert.equal(result.row, undefined)
  })

  test('strategyKey falls back to key when empty (pre-2.5.1-shaped row)', async () => {
    const result = mapAuthenticationRow(baseRow({ key: 'google', strategyKey: '' }), {
      resolver: await resolver()
    })
    assert.equal(result.module, 'google')
  })

  test('malformed config fails validateConfig and is flagged, not written', async () => {
    const result = mapAuthenticationRow(
      baseRow({
        key: 'github',
        strategyKey: 'github',
        config: { clientId: 12345, clientSecret: 'secret' }
      }),
      { resolver: await resolver() }
    )
    assert.equal(result.status, 'flagged')
    assert.match(result.message!, /Client ID must be a string/)
    assert.equal(result.row, undefined)
  })

  test('domainWhitelist -> allowedEmailRegex end to end on a real row', async () => {
    const result = mapAuthenticationRow(baseRow({ domainWhitelist: { v: ['example.com'] } }), {
      resolver: await resolver()
    })
    assert.equal(result.row!.allowedEmailRegex, '^[^@]+@(example\\.com)$')
  })

  test('autoEnrollGroups remap end to end on a real row', async () => {
    const result = mapAuthenticationRow(baseRow({ autoEnrollGroups: { v: [1, 2] } }), {
      resolver: await resolver(),
      groupIdMap: new Map([[1, 'uuid-1']])
    })
    assert.deepEqual(result.row!.autoEnrollGroups, ['uuid-1'])
  })
})

describe('multi-source conflict policy', () => {
  test('additive (default): a second source configuring the same module gets its own row with a disambiguated displayName', async () => {
    const state = createAuthenticationMapperState()
    const res = await resolver()

    const first = mapAuthenticationRow(baseRow({ key: 'local-src-a' }), { resolver: res, state })
    const second = mapAuthenticationRow(baseRow({ key: 'local-src-b' }), { resolver: res, state })

    assert.equal(first.status, 'created')
    assert.equal(second.status, 'created')
    assert.equal(first.row!.displayName, 'Local Database')
    assert.equal(second.row!.displayName, 'Local Database (2)')
  })

  test('additive: a third colliding source keeps counting up', async () => {
    const state = createAuthenticationMapperState()
    const res = await resolver()
    mapAuthenticationRow(baseRow({ key: 'a' }), { resolver: res, state })
    mapAuthenticationRow(baseRow({ key: 'b' }), { resolver: res, state })
    const third = mapAuthenticationRow(baseRow({ key: 'c' }), { resolver: res, state })
    assert.equal(third.row!.displayName, 'Local Database (3)')
  })

  test('additive: distinct displayNames never get renamed', async () => {
    const state = createAuthenticationMapperState()
    const res = await resolver()
    const first = mapAuthenticationRow(baseRow({ key: 'a', displayName: 'Corp A Login' }), {
      resolver: res,
      state
    })
    const second = mapAuthenticationRow(baseRow({ key: 'b', displayName: 'Corp B Login' }), {
      resolver: res,
      state
    })
    assert.equal(first.row!.displayName, 'Corp A Login')
    assert.equal(second.row!.displayName, 'Corp B Login')
  })

  test('first-source-wins: a later source reconfiguring the same module is flagged conflict-skipped, not written', async () => {
    const state = createAuthenticationMapperState()
    const res = await resolver()

    const first = mapAuthenticationRow(baseRow({ key: 'local-src-a' }), {
      resolver: res,
      state,
      conflictPolicy: 'first-source-wins'
    })
    const second = mapAuthenticationRow(baseRow({ key: 'local-src-b' }), {
      resolver: res,
      state,
      conflictPolicy: 'first-source-wins'
    })

    assert.equal(first.status, 'created')
    assert.equal(second.status, 'conflict-skipped')
    assert.equal(second.row, undefined)
    assert.match(second.message!, /already configured by an earlier source/)
  })

  test('first-source-wins: a different module from the second source is unaffected', async () => {
    const state = createAuthenticationMapperState()
    const res = await resolver()

    mapAuthenticationRow(baseRow({ key: 'local-src-a' }), {
      resolver: res,
      state,
      conflictPolicy: 'first-source-wins'
    })
    const githubRow = mapAuthenticationRow(
      baseRow({
        key: 'github-src-b',
        strategyKey: 'github',
        config: { clientId: 'x', clientSecret: 'y' }
      }),
      { resolver: res, state, conflictPolicy: 'first-source-wins' }
    )

    assert.equal(githubRow.status, 'created')
  })

  test('mapAuthenticationRows threads one state across two source batches (the real consolidation shape)', async () => {
    const state = createAuthenticationMapperState()
    const res = await resolver()

    const sourceA = [baseRow({ key: 'local' })]
    const sourceB = [baseRow({ key: 'local' })]

    const resultA = await mapAuthenticationRows(sourceA, { resolver: res, state })
    const resultB = await mapAuthenticationRows(sourceB, { resolver: res, state })

    assert.equal(resultA.createdRows.length, 1)
    assert.equal(resultB.createdRows.length, 1)
    assert.equal(resultA.createdRows[0].displayName, 'Local Database')
    assert.equal(resultB.createdRows[0].displayName, 'Local Database (2)')
    assert.equal(resultB.results[0].status, 'created')
  })
})
