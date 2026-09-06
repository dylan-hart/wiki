import { describe, test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import OAuth2Authentication from './authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** A configured instance pointed at endpoints, without spending them on a real provider. */
function makeConf(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    authorizationURL: 'https://provider.example/oauth2/authorize',
    tokenURL: 'https://provider.example/oauth2/token',
    userInfoURL: 'https://provider.example/oauth2/userinfo',
    ...overrides
  }
}

const flow = {
  redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
  state: 'the-state',
  nonce: 'unused-for-bare-oauth2',
  codeVerifier: 'unused-for-bare-oauth2'
}

describe('OAuth2Authentication', () => {
  describe('authorizationUrl', () => {
    test('builds the authorization request from admin-configured endpoints, scope and state', async () => {
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ scope: 'read:user read:email' })
      )
      const url = new URL(await oauth2.authorizationUrl(flow))
      assert.equal(url.origin + url.pathname, 'https://provider.example/oauth2/authorize')
      assert.equal(url.searchParams.get('response_type'), 'code')
      assert.equal(url.searchParams.get('client_id'), 'client-abc')
      assert.equal(url.searchParams.get('redirect_uri'), flow.redirectUri)
      assert.equal(url.searchParams.get('scope'), 'read:user read:email')
      assert.equal(url.searchParams.get('state'), 'the-state')
    })

    test('omits the scope parameter when no scope is configured, rather than sending an empty one', async () => {
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      const url = new URL(await oauth2.authorizationUrl(flow))
      assert.equal(url.searchParams.has('scope'), false)
    })

    test('throws ERR_STRATEGY_MISCONFIGURED when a required endpoint or credential is missing', async () => {
      for (const missing of ['clientId', 'clientSecret', 'authorizationURL', 'tokenURL']) {
        const conf = makeConf()
        delete conf[missing]
        const oauth2 = new OAuth2Authentication('strategy-1', conf)
        await assert.rejects(oauth2.authorizationUrl(flow), /ERR_STRATEGY_MISCONFIGURED/, missing)
      }
    })

    test('requests scope unchanged when mapGroups is off, even if groupsScope is set', async () => {
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ scope: 'read:user', groupsScope: 'read:groups' })
      )
      const url = new URL(await oauth2.authorizationUrl(flow))
      assert.equal(url.searchParams.get('scope'), 'read:user')
    })

    test('appends groupsScope when mapGroups is on and the scope does not already include it', async () => {
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ scope: 'read:user', mapGroups: true, groupsScope: 'read:groups' })
      )
      const url = new URL(await oauth2.authorizationUrl(flow))
      assert.equal(url.searchParams.get('scope'), 'read:user read:groups')
    })

    test('does not duplicate groupsScope when it is already part of the configured scope', async () => {
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ scope: 'read:user read:groups', mapGroups: true, groupsScope: 'read:groups' })
      )
      const url = new URL(await oauth2.authorizationUrl(flow))
      assert.equal(url.searchParams.get('scope'), 'read:user read:groups')
    })

    test('uses groupsScope alone when mapGroups is on and no other scope was configured', async () => {
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ mapGroups: true, groupsScope: 'read:groups' })
      )
      const url = new URL(await oauth2.authorizationUrl(flow))
      assert.equal(url.searchParams.get('scope'), 'read:groups')
    })

    test('omits scope when mapGroups is on but groupsScope is left empty and no other scope was configured', async () => {
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf({ mapGroups: true }))
      const url = new URL(await oauth2.authorizationUrl(flow))
      assert.equal(url.searchParams.has('scope'), false)
    })
  })

  describe('profile', () => {
    let fetchMock: ReturnType<typeof mock.method>

    afterEach(() => {
      fetchMock?.mock.restore()
    })

    test('exchanges the code, then GETs userInfoURL with the access token and maps the configured claims', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any, init: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          assert.equal(init.method, 'POST')
          const body = new URLSearchParams(init.body)
          assert.equal(body.get('grant_type'), 'authorization_code')
          assert.equal(body.get('code'), 'the-code')
          assert.equal(body.get('client_id'), 'client-abc')
          assert.equal(body.get('client_secret'), 'secret-xyz')
          assert.equal(body.get('redirect_uri'), flow.redirectUri)
          return new Response(
            JSON.stringify({ access_token: 'the-access-token', token_type: 'bearer' }),
            {
              status: 200
            }
          )
        }
        if (url === 'https://provider.example/oauth2/userinfo') {
          assert.equal(init.headers.Authorization, 'Bearer the-access-token')
          return new Response(
            JSON.stringify({ sub: 'user-42', mail: 'person@example.com', full_name: 'A Person' }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch to ${url}`)
      })

      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ userIdClaim: 'sub', emailClaim: 'mail', displayNameClaim: 'full_name' })
      )
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile, { id: 'user-42', email: 'person@example.com', name: 'A Person' })
      assert.equal(fetchMock.mock.callCount(), 2)
    })

    test('falls back to the default id/email/displayName claim names when none are configured', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 7, email: 'person@example.com' }), { status: 200 })
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      // -> no displayName claim present in the response, so the name falls back to the email
      assert.deepEqual(profile, {
        id: '7',
        email: 'person@example.com',
        name: 'person@example.com'
      })
    })

    test('throws ERR_NO_AUTHORIZATION_CODE when the provider redirected back with no code', async () => {
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: undefined }),
        /ERR_NO_AUTHORIZATION_CODE/
      )
    })

    test('throws ERR_TOKEN_EXCHANGE_FAILED when the token endpoint refuses the code', async () => {
      fetchMock = mock.method(
        globalThis,
        'fetch',
        async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      )
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_TOKEN_EXCHANGE_FAILED/
      )
    })

    test('throws ERR_TOKEN_EXCHANGE_FAILED when the token endpoint answers 200 with an error field', async () => {
      // -> mirrors github/authentication.ts: some providers report a refused exchange as 200 + `error`
      fetchMock = mock.method(
        globalThis,
        'fetch',
        async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 200 })
      )
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_TOKEN_EXCHANGE_FAILED/
      )
    })

    test('throws ERR_TOKEN_EXCHANGE_FAILED when the userInfoURL request itself fails', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response('not authorized', { status: 401 })
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_TOKEN_EXCHANGE_FAILED/
      )
    })

    test('throws ERR_NO_EMAIL_FROM_PROVIDER when the mapped email claim is absent from userinfo', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 7 }), { status: 200 })
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_NO_EMAIL_FROM_PROVIDER/
      )
    })

    test('throws ERR_EMAIL_NOT_VERIFIED when the configured verification claim is present and false', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ id: 7, email: 'person@example.com', verified: false }),
          { status: 200 }
        )
      })
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ emailVerifiedClaim: 'verified' })
      )
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_EMAIL_NOT_VERIFIED/
      )
    })

    test('accepts the login when the configured verification claim is absent from userinfo', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 7, email: 'person@example.com' }), { status: 200 })
      })
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ emailVerifiedClaim: 'verified' })
      )
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'person@example.com')
    })

    test('accepts the login when no emailVerifiedClaim is configured at all, even if the response reports false', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ id: 7, email: 'person@example.com', verified: false }),
          { status: 200 }
        )
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'person@example.com')
    })

    test('throws ERR_NO_PROVIDER_ACCOUNT when the mapped id claim is absent from userinfo', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(JSON.stringify({ email: 'person@example.com' }), { status: 200 })
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_NO_PROVIDER_ACCOUNT/
      )
    })

    /**
     * Every branded preset built on this module (`discord/authentication.ts`) inherits this behavior
     * unchanged by delegating to `mapProfile()` — see `discord/authentication.test.ts`'s own group-
     * mapping tests. OpenProject #826.
     */
    test('leaves `groups` absent from the profile when mapGroups is off, even if the field is present', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ id: 7, email: 'person@example.com', groups: ['editors'] }),
          { status: 200 }
        )
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal('groups' in profile, false)
    })

    test('maps the configured groupsClaim onto profile.groups when mapGroups is on', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ id: 7, email: 'person@example.com', roles: ['editors', 'admins'] }),
          { status: 200 }
        )
      })
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ mapGroups: true, groupsClaim: 'roles' })
      )
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, ['editors', 'admins'])
    })

    test('reports an empty array, not undefined, when mapGroups is on but the claim is absent from userinfo', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 7, email: 'person@example.com' }), { status: 200 })
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf({ mapGroups: true }))
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, [])
    })

    /**
     * `emailVerifiedClaim` is unset for a bare OAuth2 config by default -- most providers speaking
     * plain OAuth2 have no such field at all (see the class doc comment) -- so these exercise it only
     * once it is named, the same way `discord/authentication.ts` names it as `verified`.
     */
    test('throws ERR_EMAIL_NOT_VERIFIED when the configured verification claim is explicitly false', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ id: 7, email: 'person@example.com', verified: false }),
          { status: 200 }
        )
      })
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ emailVerifiedClaim: 'verified' })
      )
      await assert.rejects(
        oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_EMAIL_NOT_VERIFIED/
      )
    })

    test('accepts the profile when the configured verification claim is absent from userinfo', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(JSON.stringify({ id: 7, email: 'person@example.com' }), { status: 200 })
      })
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ emailVerifiedClaim: 'verified' })
      )
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'person@example.com')
    })

    test('allowUnverifiedEmail re-permits an explicitly-false verification claim', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ id: 7, email: 'person@example.com', verified: false }),
          { status: 200 }
        )
      })
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ emailVerifiedClaim: 'verified', allowUnverifiedEmail: true })
      )
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'person@example.com')
    })
  })

  describe('logoutUrl', () => {
    test('returns the configured logout URL, or null when none is set', () => {
      assert.equal(
        new OAuth2Authentication(
          's',
          makeConf({ logoutURL: 'https://provider.example/logout' })
        ).logoutUrl(),
        'https://provider.example/logout'
      )
      assert.equal(new OAuth2Authentication('s', makeConf()).logoutUrl(), null)
    })
  })

  describe('against a throwaway OAuth2 app (a GitHub OAuth app treated as generic, ignoring the real github module)', () => {
    let fetchMock: ReturnType<typeof mock.method>

    afterEach(() => {
      fetchMock?.mock.restore()
    })

    test("walks the whole flow using GitHub's actual endpoint shapes, proving the generic path against a real provider", async () => {
      const conf = makeConf({
        authorizationURL: 'https://github.com/login/oauth/authorize',
        tokenURL: 'https://github.com/login/oauth/access_token',
        userInfoURL: 'https://api.github.com/user',
        scope: 'read:user user:email',
        userIdClaim: 'id',
        emailClaim: 'email',
        displayNameClaim: 'name'
      })

      const authUrl = new URL(
        await new OAuth2Authentication('strategy-1', conf).authorizationUrl(flow)
      )
      assert.equal(authUrl.origin + authUrl.pathname, 'https://github.com/login/oauth/authorize')
      assert.equal(authUrl.searchParams.get('scope'), 'read:user user:email')

      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        // -> GitHub's real access_token response, JSON because `Accept: application/json` is sent
        if (url === 'https://github.com/login/oauth/access_token') {
          return new Response(
            JSON.stringify({
              access_token: 'gho_faketoken',
              token_type: 'bearer',
              scope: 'read:user,user:email'
            }),
            { status: 200 }
          )
        }
        // -> GitHub's real /user shape: public email is often null, but this throwaway app set one
        if (url === 'https://api.github.com/user') {
          return new Response(
            JSON.stringify({
              id: 123456,
              login: 'octocat',
              name: 'The Octocat',
              email: 'octocat@example.com'
            }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch to ${url}`)
      })

      const oauth2 = new OAuth2Authentication('strategy-1', conf)
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'throwaway-code' })
      // -> GitHub issues no separated halves, so neither key is on the profile at all — the whole
      //    point of leaving them off rather than writing two empty strings.
      assert.deepEqual(profile, {
        id: '123456',
        email: 'octocat@example.com',
        name: 'The Octocat'
      })
    })
  })

  /*
    Feature #2608. `discord`, `slack` and `twitch` all inherit `mapProfile()` from this class, so a
    claim read added here is added to them too — which is why nothing in this base falls back to
    splitting the display name when the halves come back empty. That fallback is per-preset (Task
    #2641), and doing it here would fire for every provider built on this module.
  */
  describe('mapProfile: separated name halves', () => {
    let fetchMock: any
    afterEach(() => {
      fetchMock?.mock.restore()
    })

    /** Answers the token exchange, then hands `info` back as the userinfo response. */
    function stubUserInfo(info: Record<string, any>): void {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        if (String(input) === 'https://provider.example/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        }
        return new Response(JSON.stringify(info), { status: 200 })
      })
    }

    test('reads the default firstName/lastName fields off the userinfo response', async () => {
      stubUserInfo({
        id: 7,
        email: 'person@example.com',
        displayName: 'Alice Example',
        firstName: 'Alice',
        lastName: 'Example'
      })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.firstName, 'Alice')
      assert.equal(profile.lastName, 'Example')
      // -> Still the display-name claim; the model derives `name` from the halves, not this module.
      assert.equal(profile.name, 'Alice Example')
    })

    test('honors configured non-standard field names for either half', async () => {
      stubUserInfo({
        id: 7,
        email: 'person@example.com',
        given_name: 'Alice',
        family_name: 'Example',
        firstName: 'Wrong',
        lastName: 'Wrong'
      })
      const oauth2 = new OAuth2Authentication(
        'strategy-1',
        makeConf({ firstNameClaim: 'given_name', lastNameClaim: 'family_name' })
      )
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.firstName, 'Alice')
      assert.equal(profile.lastName, 'Example')
    })

    test('a provider reporting neither half leaves both keys off the profile', async () => {
      stubUserInfo({ id: 7, email: 'person@example.com', displayName: 'A Person' })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal('firstName' in profile, false)
      assert.equal('lastName' in profile, false)
    })

    test('a mononym keeps its first half and gets no invented surname', async () => {
      stubUserInfo({ id: 7, email: 'person@example.com', firstName: 'Prince', lastName: '' })
      const oauth2 = new OAuth2Authentication('strategy-1', makeConf())
      const profile = await oauth2.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.firstName, 'Prince')
      assert.equal('lastName' in profile, false)
    })
  })
})

describe('oauth2/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the github/google/oidc branding convention', () => {
    assert.equal(def.key, 'oauth2')
    assert.equal(def.title, 'Generic OAuth2')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-oauth2.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test("has a color distinct from the oidc preset's, so the two generic entries read apart in the module picker", () => {
    const oidcDef = load(
      readFileSync(path.join(__dirname, '..', 'oidc', 'definition.yml'), 'utf-8')
    ) as Record<string, any>
    assert.notEqual(def.color, oidcDef.color)
  })

  test('declares the bare-OAuth2 props: endpoints, credentials, claim mappings, scope, logout', () => {
    for (const prop of [
      'clientId',
      'clientSecret',
      'authorizationURL',
      'tokenURL',
      'userInfoURL',
      'userIdClaim',
      'emailClaim',
      'displayNameClaim',
      'scope',
      'logoutURL'
    ]) {
      assert.ok(def.props[prop], `expected a ${prop} prop`)
    }
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('declares an optional emailVerifiedClaim prop for honouring provider-reported email verification', () => {
    assert.ok(def.props.emailVerifiedClaim, 'expected an emailVerifiedClaim prop')
    assert.equal(def.props.emailVerifiedClaim.default, '')
  })

  test('declares mapGroups/groupsClaim/groupsScope props for group-claim mapping (OpenProject #826)', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
    assert.ok(def.props.groupsScope, 'expected a groupsScope prop')
  })

  test('declares emailVerifiedClaim (unset by default) and allowUnverifiedEmail (off by default)', () => {
    assert.ok(def.props.emailVerifiedClaim, 'expected an emailVerifiedClaim prop')
    assert.ok(def.props.allowUnverifiedEmail, 'expected an allowUnverifiedEmail prop')
    assert.equal(def.props.allowUnverifiedEmail.default, false)
  })

  test('drops the props this task calls out as unneeded: pictureClaim, useQueryStringForAccessToken, enableCSRFProtection', () => {
    assert.equal(def.props.pictureClaim, undefined)
    assert.equal(def.props.useQueryStringForAccessToken, undefined)
    assert.equal(def.props.enableCSRFProtection, undefined)
  })

  test('the callback URL ref matches the {host}/_api/auth/{id}/callback convention every module uses', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })

  test("declares firstNameClaim/lastNameClaim, defaulted to this definition's camelCase house style (Feature #2608)", () => {
    assert.equal(def.props.firstNameClaim?.default, 'firstName')
    assert.equal(def.props.lastNameClaim?.default, 'lastName')
  })

  test('every prop still has a distinct order, after the two name claims were inserted mid-list', () => {
    const orders = Object.values(def.props).map((p: any) => p.order)
    assert.equal(new Set(orders).size, orders.length)
  })
})
