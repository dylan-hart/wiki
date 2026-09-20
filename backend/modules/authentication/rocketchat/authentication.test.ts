import { describe, test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import RocketChatAuthentication from './authentication.ts'
import OAuth2Authentication from '../oauth2/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const flow = {
  redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
  state: 'the-state',
  nonce: 'unused',
  codeVerifier: 'unused'
}

const baseConf = {
  serverUrl: 'https://chat.example.com',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz'
}

describe('RocketChatAuthentication', () => {
  test('is an OAuth2Authentication, delegating the token exchange rather than reimplementing it', () => {
    const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
    assert.ok(rocketchat instanceof OAuth2Authentication)
  })

  describe('endpoint templating', () => {
    test('templates the authorization/token/userinfo endpoints off serverUrl', () => {
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      assert.equal(rocketchat.conf.authorizationURL, 'https://chat.example.com/oauth/authorize')
      assert.equal(rocketchat.conf.tokenURL, 'https://chat.example.com/oauth/token')
      assert.equal(rocketchat.conf.userInfoURL, 'https://chat.example.com/api/v1/me')
    })

    test('trims a trailing slash off serverUrl, the same way keycloak trims baseUrl', () => {
      const rocketchat = new RocketChatAuthentication('strategy-1', {
        ...baseConf,
        serverUrl: 'https://chat.example.com/'
      })
      assert.equal(rocketchat.conf.authorizationURL, 'https://chat.example.com/oauth/authorize')
      assert.equal(rocketchat.conf.tokenURL, 'https://chat.example.com/oauth/token')
      assert.equal(rocketchat.conf.userInfoURL, 'https://chat.example.com/api/v1/me')
    })

    test('a strategy missing serverUrl/clientId/clientSecret fails the same way the generic module fails', async () => {
      const rocketchat = new RocketChatAuthentication('strategy-1', {})
      await assert.rejects(rocketchat.authorizationUrl(flow), /ERR_STRATEGY_MISCONFIGURED/)
    })

    test('a strategy with credentials but no serverUrl still refuses as misconfigured, rather than building a hostless URL', async () => {
      const rocketchat = new RocketChatAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz'
      })
      assert.equal(rocketchat.conf.authorizationURL, undefined)
      await assert.rejects(rocketchat.authorizationUrl(flow), /ERR_STRATEGY_MISCONFIGURED/)
    })

    test('the authorization URL is built from the templated endpoint', async () => {
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      const url = new URL(await rocketchat.authorizationUrl(flow))
      assert.equal(url.origin + url.pathname, 'https://chat.example.com/oauth/authorize')
      assert.equal(url.searchParams.get('client_id'), 'client-abc')
      assert.equal(url.searchParams.get('redirect_uri'), flow.redirectUri)
    })
  })

  describe('profile', () => {
    let fetchMock: ReturnType<typeof mock.method>

    afterEach(() => {
      fetchMock?.mock.restore()
    })

    function mockTokenExchange(meResponse: Record<string, any>) {
      return mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://chat.example.com/oauth/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://chat.example.com/api/v1/me') {
          return new Response(JSON.stringify(meResponse), { status: 200 })
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
    }

    test('maps id/email/name from /api/v1/me, pulling email out of the emails array', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'Ada Lovelace',
        username: 'ada',
        emails: [{ address: 'ada@example.com', verified: true }]
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      const profile = await rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile, {
        id: 'abc123',
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        firstName: 'Ada',
        lastName: 'Lovelace'
      })
    })

    test('a mononym name yields an empty lastName rather than an invented one', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'octocat',
        emails: [{ address: 'octocat@example.com', verified: true }]
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      const profile = await rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.firstName, 'octocat')
      assert.equal(profile.lastName, '')
    })

    test('throws ERR_NO_EMAIL_FROM_PROVIDER when emails is missing', async () => {
      fetchMock = mockTokenExchange({ _id: 'abc123', name: 'Ada Lovelace' })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      await assert.rejects(
        rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_NO_EMAIL_FROM_PROVIDER/
      )
    })

    test('throws ERR_NO_EMAIL_FROM_PROVIDER when emails is an empty array', async () => {
      fetchMock = mockTokenExchange({ _id: 'abc123', name: 'Ada Lovelace', emails: [] })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      await assert.rejects(
        rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_NO_EMAIL_FROM_PROVIDER/
      )
    })

    test('throws ERR_EMAIL_NOT_VERIFIED when emails[0].verified is false', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'Ada Lovelace',
        emails: [{ address: 'ada@example.com', verified: false }]
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      await assert.rejects(
        rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_EMAIL_NOT_VERIFIED/
      )
    })

    test('allowUnverifiedEmail re-permits an explicitly-false emails[0].verified claim', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'Ada Lovelace',
        emails: [{ address: 'ada@example.com', verified: false }]
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', {
        ...baseConf,
        allowUnverifiedEmail: true
      })
      const profile = await rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'ada@example.com')
    })

    test('signs in normally when emails[0].verified is true', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'Ada Lovelace',
        emails: [{ address: 'ada@example.com', verified: true }]
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      const profile = await rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'ada@example.com')
    })

    test('only the first email in the array is used, even when several are present', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'Ada Lovelace',
        emails: [
          { address: 'primary@example.com', verified: true },
          { address: 'secondary@example.com', verified: true }
        ]
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      const profile = await rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'primary@example.com')
    })

    /**
     * Stock Rocket.Chat reports no such field on `/api/v1/me`: the fixture is synthetic, and what is
     * under test is the inherited `OAuth2Authentication.mapProfile()` mapping, not a real claim.
     */
    test('maps the configured groupsClaim onto profile.groups when mapGroups is on', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'Ada Lovelace',
        emails: [{ address: 'ada@example.com', verified: true }],
        roles: ['moderator', 'editor']
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', {
        ...baseConf,
        mapGroups: true,
        groupsClaim: 'roles'
      })
      const profile = await rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, ['moderator', 'editor'])
    })

    test('leaves profile.groups absent when mapGroups is off', async () => {
      fetchMock = mockTokenExchange({
        _id: 'abc123',
        name: 'Ada Lovelace',
        emails: [{ address: 'ada@example.com', verified: true }]
      })
      const rocketchat = new RocketChatAuthentication('strategy-1', baseConf)
      const profile = await rocketchat.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal('groups' in profile, false)
    })

    test("the display-name fallback is this preset's own, not the generic OAuth2 module's", () => {
      /*
        A fallback placed on `OAuth2Authentication` itself would fire for every plain-OAuth2
        strategy, including one whose provider reports real name claims.
      */
      const generic = new OAuth2Authentication('strategy-2', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        authorizationURL: 'https://provider.example/authorize',
        tokenURL: 'https://provider.example/token',
        userInfoURL: 'https://provider.example/userinfo'
      })
      const mapProfile = (generic as unknown as { mapProfile(info: Record<string, any>): any })
        .mapProfile
      const profile = mapProfile.call(generic, {
        id: '1',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com'
      })
      assert.equal(profile.name, 'Ada Lovelace')
      assert.ok(!profile.firstName, 'the generic OAuth2 mapping must not split the display name')
      assert.ok(!profile.lastName, 'the generic OAuth2 mapping must not split the display name')
    })
  })
})

describe('rocketchat/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the discord/keycloak branding convention', () => {
    assert.equal(def.key, 'rocketchat')
    assert.equal(def.title, 'Rocket.Chat')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-rocketchat.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares a serverUrl prop — self-hosted, like keycloak, not a fixed host like discord', () => {
    assert.ok(def.props.serverUrl, 'expected a serverUrl prop')
  })

  test('declares no endpoint/scope/claim props — those are fixed by the module, only serverUrl and credentials are admin-supplied', () => {
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
    for (const prop of ['authorizationURL', 'tokenURL', 'userInfoURL', 'scope']) {
      assert.equal(def.props[prop], undefined, `${prop} should be fixed, not admin-supplied`)
    }
  })

  test('declares mapGroups/groupsClaim props for group-claim mapping (OpenProject #826), consistent with every other preset even though stock Rocket.Chat reports no such field', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
  })

  test('declares an allowUnverifiedEmail prop, matching the shape google/definition.yml uses (OpenProject #3304)', () => {
    assert.equal(def.props.allowUnverifiedEmail.type, 'Boolean')
    assert.equal(def.props.allowUnverifiedEmail.default, false)
  })

  test('the callback URL ref matches the {host}/_api/auth/{id}/callback convention every module uses', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
