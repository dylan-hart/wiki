import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import OidcAuthentication, { mapOidcProfile } from './authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * `authorizationUrl` is exercised for real here (no `OidcAuthentication.prototype` mocking) via the
 * `useDiscovery: false` branch of `configuration()`, which builds a `client.Configuration` directly
 * from the endpoints given rather than fetching a discovery document — so this needs no network and
 * still runs the actual `openid-client` `buildAuthorizationUrl` call.
 */
describe('OidcAuthentication#authorizationUrl', () => {
  const manualConf = {
    clientId: 'abc',
    clientSecret: 'xyz',
    issuer: 'https://issuer.example',
    useDiscovery: false,
    authorizationURL: 'https://issuer.example/authorize',
    tokenURL: 'https://issuer.example/token',
    jwksURL: 'https://issuer.example/jwks'
  }
  const flow = {
    redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
    state: 's',
    nonce: 'n',
    codeVerifier: 'v'
  }

  test('carries no extra query params when the config sets none', async () => {
    const auth = new OidcAuthentication('strategy-1', manualConf)
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('claims'), null)
  })

  test('extraAuthParams from conf are merged onto the built authorization URL', async () => {
    const claims = JSON.stringify({ id_token: { email: null }, userinfo: { email: null } })
    const auth = new OidcAuthentication('strategy-1', {
      ...manualConf,
      extraAuthParams: { claims }
    })
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('claims'), claims)
    // -> The generic params this module has always sent are still present alongside it
    assert.equal(url.searchParams.get('redirect_uri'), flow.redirectUri)
    assert.equal(url.searchParams.get('state'), flow.state)
  })

  test('requests the default scope unchanged when mapGroups is off, even if groupsScope is set', async () => {
    const auth = new OidcAuthentication('strategy-1', {
      ...manualConf,
      groupsScope: 'groups'
    })
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('scope'), 'openid profile email')
  })

  test('appends groupsScope when mapGroups is on and the scope does not already include it', async () => {
    const auth = new OidcAuthentication('strategy-1', {
      ...manualConf,
      mapGroups: true,
      groupsScope: 'groups'
    })
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('scope'), 'openid profile email groups')
  })

  test('does not duplicate groupsScope when it is already part of the configured scopes', async () => {
    const auth = new OidcAuthentication('strategy-1', {
      ...manualConf,
      scopes: 'openid profile email groups',
      mapGroups: true,
      groupsScope: 'groups'
    })
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('scope'), 'openid profile email groups')
  })

  test('leaves scope untouched when mapGroups is on but groupsScope is left empty', async () => {
    const auth = new OidcAuthentication('strategy-1', {
      ...manualConf,
      mapGroups: true
    })
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('scope'), 'openid profile email')
  })
})

/**
 * `mapOidcProfile` is where every OIDC preset's group-claim mapping actually lives — the branded
 * presets (`auth0/authentication.ts` and friends) inherit it unchanged by delegating to this module,
 * so exercising it here covers them too; each preset's own test only has to prove its config reaches
 * this class unmodified (see e.g. `auth0/authentication.test.ts`).
 */
describe('mapOidcProfile', () => {
  const conf = { emailClaim: 'email', displayNameClaim: 'name' }

  test('leaves `groups` absent from the profile when mapGroups is off, even if the claim is present', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      groups: ['editors']
    })
    assert.deepEqual(profile, { id: 'sub-1', email: 'person@example.com', name: 'A Person' })
    assert.equal('groups' in profile, false)
  })

  test('maps the configured groupsClaim onto `groups` when mapGroups is on', () => {
    const profile = mapOidcProfile({ ...conf, mapGroups: true }, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      groups: ['editors', 'admins']
    })
    assert.deepEqual(profile.groups, ['editors', 'admins'])
  })

  test('honors a custom groupsClaim name, e.g. a provider putting roles under `roles`', () => {
    const profile = mapOidcProfile({ ...conf, mapGroups: true, groupsClaim: 'roles' }, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      roles: ['viewer']
    })
    assert.deepEqual(profile.groups, ['viewer'])
  })

  test('reports an empty array, not undefined, when mapGroups is on but the claim is absent', () => {
    const profile = mapOidcProfile({ ...conf, mapGroups: true }, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person'
    })
    assert.deepEqual(profile.groups, [])
  })

  test('normalizes a single-value claim to a one-element array', () => {
    const profile = mapOidcProfile({ ...conf, mapGroups: true }, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      groups: 'editors'
    })
    assert.deepEqual(profile.groups, ['editors'])
  })

  test('still throws ERR_NO_EMAIL_FROM_PROVIDER when the email claim is absent, regardless of mapGroups', () => {
    assert.throws(
      () => mapOidcProfile({ ...conf, mapGroups: true }, 'sub-1', { name: 'A Person' }),
      /ERR_NO_EMAIL_FROM_PROVIDER/
    )
  })

  test('throws ERR_EMAIL_NOT_VERIFIED when email_verified is explicitly false', () => {
    assert.throws(
      () =>
        mapOidcProfile(conf, 'sub-1', {
          email: 'person@example.com',
          name: 'A Person',
          email_verified: false
        }),
      /ERR_EMAIL_NOT_VERIFIED/
    )
  })

  test('accepts the profile when email_verified is absent -- not assumed unverified', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person'
    })
    assert.equal(profile.email, 'person@example.com')
  })

  test('accepts the profile when email_verified is explicitly true', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      email_verified: true
    })
    assert.equal(profile.email, 'person@example.com')
  })

  test('allowUnverifiedEmail re-permits an explicitly-false email_verified claim', () => {
    const profile = mapOidcProfile({ ...conf, allowUnverifiedEmail: true }, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      email_verified: false
    })
    assert.equal(profile.email, 'person@example.com')
  })

  /*
    Feature #2608. Every OIDC preset inherits these too, for the same reason the group-claim tests
    above cover them: `auth0`, `okta`, `microsoft`, `keycloak` and `gitlab` all map through this one
    function, so a claim read added here is a claim read added to all of them.
  */
  test('reads the standard given_name/family_name claims into the separated halves', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'Alice Example',
      given_name: 'Alice',
      family_name: 'Example'
    })
    assert.equal(profile.firstName, 'Alice')
    assert.equal(profile.lastName, 'Example')
    // -> `name` keeps coming from the display-name claim; deriving it from the halves is
    //    `models/users.ts`'s job, not this mapper's.
    assert.equal(profile.name, 'Alice Example')
  })

  test('honors configured non-standard claim names for either half', () => {
    const profile = mapOidcProfile(
      { ...conf, firstNameClaim: 'first_name', lastNameClaim: 'surname' },
      'sub-1',
      {
        email: 'person@example.com',
        name: 'Alice Example',
        first_name: 'Alice',
        surname: 'Example',
        // -> Present, but not what this strategy was told to read.
        given_name: 'Wrong',
        family_name: 'Wrong'
      }
    )
    assert.equal(profile.firstName, 'Alice')
    assert.equal(profile.lastName, 'Example')
  })

  test('a provider issuing only a display name leaves both halves off the profile entirely', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person'
    })
    assert.equal('firstName' in profile, false)
    assert.equal('lastName' in profile, false)
  })

  test('a mononym -- given_name with no family_name -- keeps the first half and invents no surname', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'Prince',
      given_name: 'Prince'
    })
    assert.equal(profile.firstName, 'Prince')
    assert.equal('lastName' in profile, false)
  })

  test('an empty-string claim is treated as unanswered, not as an empty name', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      given_name: '   ',
      family_name: ''
    })
    assert.equal('firstName' in profile, false)
    assert.equal('lastName' in profile, false)
  })

  test('surrounding whitespace is trimmed off a half', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'Alice Example',
      given_name: '  Alice ',
      family_name: ' Example  '
    })
    assert.equal(profile.firstName, 'Alice')
    assert.equal(profile.lastName, 'Example')
  })

  test('a non-string claim value is ignored rather than stringified into a name', () => {
    const profile = mapOidcProfile(conf, 'sub-1', {
      email: 'person@example.com',
      name: 'A Person',
      given_name: { formatted: 'Alice' },
      family_name: ['Example']
    })
    assert.equal('firstName' in profile, false)
    assert.equal('lastName' in profile, false)
  })
})

describe('oidc/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('declares mapGroups/groupsClaim/groupsScope props for group-claim mapping (OpenProject #826)', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
    assert.ok(def.props.groupsScope, 'expected a groupsScope prop')
    assert.equal(def.props.mapGroups.default, false)
    assert.equal(def.props.groupsClaim.default, 'groups')
  })

  test('declares allowUnverifiedEmail, off by default', () => {
    assert.ok(def.props.allowUnverifiedEmail, 'expected an allowUnverifiedEmail prop')
    assert.equal(def.props.allowUnverifiedEmail.default, false)
  })

  test('declares firstNameClaim/lastNameClaim, defaulted to the OIDC standard claims (Feature #2608)', () => {
    assert.equal(def.props.firstNameClaim?.default, 'given_name')
    assert.equal(def.props.lastNameClaim?.default, 'family_name')
  })

  test('every prop still has a distinct order, after the two name claims were inserted mid-list', () => {
    const orders = Object.values(def.props).map((p: any) => p.order)
    assert.equal(new Set(orders).size, orders.length)
  })
})
