import { describe, test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import FacebookAuthentication from './authentication.ts'
import OAuth2Authentication from '../oauth2/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const flow = {
  redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
  state: 'the-state',
  nonce: 'unused',
  codeVerifier: 'unused'
}

describe('FacebookAuthentication', () => {
  test('is an OAuth2Authentication, delegating the token exchange rather than reimplementing it', () => {
    const facebook = new FacebookAuthentication('strategy-1', {
      clientId: 'app-id-abc',
      clientSecret: 'app-secret-xyz'
    })
    assert.ok(facebook instanceof OAuth2Authentication)
  })

  describe('authorizationUrl', () => {
    test('fixes the authorization URL and scope — Facebook has one fixed set of endpoints', async () => {
      const facebook = new FacebookAuthentication('strategy-1', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz'
      })
      const url = new URL(await facebook.authorizationUrl(flow))
      assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v19.0/dialog/oauth')
      assert.equal(url.searchParams.get('scope'), 'email public_profile')
      assert.equal(url.searchParams.get('client_id'), 'app-id-abc')
      assert.equal(url.searchParams.get('redirect_uri'), flow.redirectUri)
    })

    test('a strategy missing clientId/clientSecret fails the same way the generic module fails', async () => {
      const facebook = new FacebookAuthentication('strategy-1', {})
      await assert.rejects(facebook.authorizationUrl(flow), /ERR_STRATEGY_MISCONFIGURED/)
    })
  })

  describe('profile', () => {
    let fetchMock: ReturnType<typeof mock.method>

    afterEach(() => {
      fetchMock?.mock.restore()
    })

    function mockTokenExchange(
      meResponse: Record<string, any> = {
        id: '1234567890',
        name: 'octocat',
        email: 'octocat@example.com'
      }
    ) {
      return mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://graph.facebook.com/v19.0/oauth/access_token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://graph.facebook.com/me?fields=id,name,email') {
          return new Response(JSON.stringify(meResponse), { status: 200 })
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
    }

    test('requests the fields-qualified /me endpoint and maps id/email/name', async () => {
      fetchMock = mockTokenExchange()
      const facebook = new FacebookAuthentication('strategy-1', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz'
      })
      const profile = await facebook.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile, {
        id: '1234567890',
        email: 'octocat@example.com',
        name: 'octocat',
        // -> Facebook issues one display string and no separated halves, so a single-word name is a
        //    mononym: nothing is invented for the surname.
        firstName: 'octocat',
        lastName: ''
      })
      assert.ok(
        fetchMock.mock.calls.some(
          (c) => String(c.arguments[0]) === 'https://graph.facebook.com/me?fields=id,name,email'
        )
      )
    })

    test('splits a multi-word display string into first and last name', async () => {
      fetchMock = mockTokenExchange({ id: '1', name: 'Ada Lovelace', email: 'ada@example.com' })
      const facebook = new FacebookAuthentication('strategy-1', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz'
      })
      const profile = await facebook.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.firstName, 'Ada')
      assert.equal(profile.lastName, 'Lovelace')
      // -> the display name itself is untouched by the split
      assert.equal(profile.name, 'Ada Lovelace')
    })

    test("the display-name fallback is this preset's own, not the generic OAuth2 module's", () => {
      /*
        Blast-radius guard. `OAuth2Authentication` is the base class for any admin-configured plain
        OAuth2 strategy, and a display-name split placed there would fire for every one of them --
        including a provider that does report real name claims. The generic mapping is allowed to
        fill the halves from claims it was configured to read; it must never manufacture them out of
        the display string, which is what this asserts.
      */
      const generic = new OAuth2Authentication('strategy-2', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz',
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

    test('throws ERR_NO_EMAIL_FROM_PROVIDER when /me reports no email (app not granted the permission, or the user denied it)', async () => {
      fetchMock = mockTokenExchange({ id: '1', name: 'octocat' })
      const facebook = new FacebookAuthentication('strategy-1', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz'
      })
      await assert.rejects(
        facebook.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_NO_EMAIL_FROM_PROVIDER/
      )
    })

    test('sends the access token as a bearer header on the /me request', async () => {
      const calls: string[] = []
      fetchMock = mock.method(globalThis, 'fetch', async (input: any, init: any) => {
        const url = String(input)
        calls.push(url)
        if (url === 'https://graph.facebook.com/v19.0/oauth/access_token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://graph.facebook.com/me?fields=id,name,email') {
          assert.equal(init.headers.Authorization, 'Bearer the-access-token')
          return new Response(
            JSON.stringify({ id: '1', name: 'octocat', email: 'octocat@example.com' }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
      const facebook = new FacebookAuthentication('strategy-1', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz'
      })
      await facebook.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(calls, [
        'https://graph.facebook.com/v19.0/oauth/access_token',
        'https://graph.facebook.com/me?fields=id,name,email'
      ])
    })

    /**
     * Facebook inherits group-claim mapping from the base `OAuth2Authentication.mapProfile()` rather
     * than reimplementing it -- the same consistency guarantee `discord/authentication.ts` gets
     * (OpenProject #826). Stock Facebook reports no such field on `/me`, so this exercises the
     * mapping mechanism itself, not a real Facebook claim.
     */
    test('maps the configured groupsClaim onto profile.groups when mapGroups is on', async () => {
      fetchMock = mockTokenExchange({
        id: '1234567890',
        name: 'octocat',
        email: 'octocat@example.com',
        roles: ['moderator', 'editor']
      })
      const facebook = new FacebookAuthentication('strategy-1', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz',
        mapGroups: true,
        groupsClaim: 'roles'
      })
      const profile = await facebook.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, ['moderator', 'editor'])
    })

    test('leaves profile.groups absent when mapGroups is off', async () => {
      fetchMock = mockTokenExchange()
      const facebook = new FacebookAuthentication('strategy-1', {
        clientId: 'app-id-abc',
        clientSecret: 'app-secret-xyz'
      })
      const profile = await facebook.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal('groups' in profile, false)
    })
  })
})

describe('facebook/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the discord/twitch/oidc branding convention', () => {
    assert.equal(def.key, 'facebook')
    assert.equal(def.title, 'Facebook')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-facebook.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares no endpoint/scope/claim props — those are fixed by the module, only credentials are admin-supplied', () => {
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
    for (const prop of ['authorizationURL', 'tokenURL', 'userInfoURL', 'scope']) {
      assert.equal(def.props[prop], undefined, `${prop} should be fixed, not admin-supplied`)
    }
  })

  test('declares no guild/organization-restriction prop — Facebook has no such equivalent', () => {
    for (const prop of ['guildId', 'allowedOrganization']) {
      assert.equal(def.props[prop], undefined, `${prop} should not exist on the Facebook preset`)
    }
  })

  test('declares mapGroups/groupsClaim/groupsScope props for group-claim mapping (OpenProject #826), consistent with every other preset even though stock Facebook reports no such field', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
    assert.ok(def.props.groupsScope, 'expected a groupsScope prop')
  })

  test('the callback URL ref matches the {host}/_api/auth/{id}/callback convention every module uses', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
