import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  buildAllowedEmailRegex,
  mapAuthenticationRow,
  type SourceAuthenticationRow
} from './authentication.ts'
import { installTestWiki } from '../../test/mocks.ts'

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

let wikiHandle: { restore(): void }

before(async () => {
  wikiHandle = installTestWiki({ SERVERPATH: path.join(import.meta.dirname, '..', '..') })
  const { authentication } = await import('../../models/authentication.ts')
  await authentication.refreshStrategiesFromDisk()
  assert.ok(
    WIKI.data.authentication?.length > 0,
    'refreshStrategiesFromDisk should have loaded the real on-disk module definitions'
  )
})

after(() => {
  wikiHandle.restore()
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

describe('mapAuthenticationRow', () => {
  test('local row: config always {} in, fully-defaulted config out, source selfRegistration mirrored onto both target flags', async () => {
    const result = mapAuthenticationRow(
      baseRow({ selfRegistration: true, displayName: 'Local Database' }),
      {
        resolver: await resolver()
      }
    )
    assert.equal(result.status, 'created')
    assert.equal(result.row!.module, 'local')
    assert.equal(result.row!.selfRegistration, true)
    assert.equal(result.row!.autoProvision, true)
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
    // -> 'firebase' has no backend/modules/authentication/firebase/ directory as of this writing
    //    (ldap gained one after this test was originally written against it -- see Feature 354).
    const result = mapAuthenticationRow(baseRow({ key: 'firebase', strategyKey: 'firebase' }), {
      resolver: await resolver()
    })
    assert.equal(result.status, 'unsupported')
    assert.equal(result.module, 'firebase')
    assert.ok(result.message?.includes('firebase'))
    assert.equal(result.row, undefined)
  })

  test('strategyKey falls back to key when empty (pre-2.5.1-shaped row)', async () => {
    const result = mapAuthenticationRow(baseRow({ key: 'google', strategyKey: '' }), {
      resolver: await resolver()
    })
    assert.equal(result.module, 'google')
  })

  test('unverified module with a non-empty config is flagged, not silently imported enabled with an empty config', async () => {
    const result = mapAuthenticationRow(
      baseRow({
        key: 'saml',
        strategyKey: 'saml',
        isEnabled: true,
        config: { entryPoint: 'https://idp.example.com/sso', cert: 'a-real-certificate' }
      }),
      { resolver: await resolver() }
    )
    assert.equal(result.status, 'flagged')
    assert.match(result.message!, /saml/)
    assert.match(result.message!, /no verified config prop-name mapping/)
    assert.equal(result.row, undefined)
  })

  test('unverified module with an empty config still comes back created (nothing to lose in the remap)', async () => {
    const result = mapAuthenticationRow(
      baseRow({
        key: 'saml',
        strategyKey: 'saml',
        config: {}
      }),
      { resolver: await resolver() }
    )
    assert.equal(result.status, 'created')
    assert.equal(result.row!.module, 'saml')
  })

  test('a covered transform (google) is unaffected by the unverified-config gate', async () => {
    const result = mapAuthenticationRow(
      baseRow({
        key: 'google',
        strategyKey: 'google',
        config: { clientId: 'abc', clientSecret: 'secret' }
      }),
      { resolver: await resolver() }
    )
    assert.equal(result.status, 'created')
    assert.equal(result.row!.module, 'google')
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

  test('autoEnrollGroups is always empty — no group has been imported by the time settings runs', async () => {
    const result = mapAuthenticationRow(baseRow({ autoEnrollGroups: { v: [1, 2] } }), {
      resolver: await resolver()
    })
    assert.deepEqual(result.row!.autoEnrollGroups, [])
  })
})
