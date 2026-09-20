import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildOidcConfig, OidcPreset } from './preset.ts'
import OidcAuthentication from './authentication.ts'

/**
 * Delegation is asserted by mocking `OidcAuthentication.prototype` and checking `OidcPreset`
 * forwards to the instance it built from the merge, so nothing here reaches `openid-client` or the
 * network.
 */

describe('buildOidcConfig', () => {
  test('the template issuer wins, derived from the admin config passed to it', () => {
    const config = buildOidcConfig(
      { issuer: (c) => `https://${c.domain}/` },
      { domain: 'something.auth0.com', clientId: 'abc', clientSecret: 'xyz' }
    )
    assert.equal(config.issuer, 'https://something.auth0.com/')
  })

  test('template scopes/claim names override whatever the admin config carries for those keys', () => {
    const config = buildOidcConfig(
      { issuer: () => 'https://issuer.example', scopes: 'openid email', emailClaim: 'mail' },
      { scopes: 'something-else', emailClaim: 'something-else', displayNameClaim: 'name' }
    )
    assert.equal(config.scopes, 'openid email')
    assert.equal(config.emailClaim, 'mail')
    assert.equal(config.displayNameClaim, 'name')
  })

  test("a template's extraAuthParams (e.g. Twitch's claims parameter) is carried onto the merged config", () => {
    const config = buildOidcConfig(
      {
        issuer: () => 'https://id.twitch.tv/oauth2',
        extraAuthParams: { claims: '{"userinfo":{"email":null}}' }
      },
      { clientId: 'abc', clientSecret: 'xyz' }
    )
    assert.deepEqual(config.extraAuthParams, { claims: '{"userinfo":{"email":null}}' })
  })

  test("a function-valued extraAuthParams (e.g. Slack's optional workspace restriction) is computed from the admin config", () => {
    const withTeam = buildOidcConfig(
      {
        issuer: () => 'https://slack.com',
        extraAuthParams: (c) => (c.teamId ? { team: c.teamId } : undefined)
      },
      { clientId: 'abc', clientSecret: 'xyz', teamId: 'T12345' }
    )
    assert.deepEqual(withTeam.extraAuthParams, { team: 'T12345' })

    const withoutTeam = buildOidcConfig(
      {
        issuer: () => 'https://slack.com',
        extraAuthParams: (c) => (c.teamId ? { team: c.teamId } : undefined)
      },
      { clientId: 'abc', clientSecret: 'xyz' }
    )
    assert.equal(withoutTeam.extraAuthParams, undefined)
  })

  test('fields the template leaves unset fall back to the admin config untouched', () => {
    const config = buildOidcConfig(
      { issuer: () => 'https://issuer.example' },
      { clientId: 'abc', clientSecret: 'xyz', scopes: 'openid profile email' }
    )
    assert.equal(config.clientId, 'abc')
    assert.equal(config.clientSecret, 'xyz')
    assert.equal(config.scopes, 'openid profile email')
    assert.equal(config.emailClaim, undefined)
  })

  test('mapGroups/groupsClaim/groupsScope are never fixed by a template — every preset gets whatever the admin configured', () => {
    const config = buildOidcConfig(
      { issuer: () => 'https://issuer.example' },
      {
        clientId: 'abc',
        clientSecret: 'xyz',
        mapGroups: true,
        groupsClaim: 'roles',
        groupsScope: 'groups'
      }
    )
    assert.equal(config.mapGroups, true)
    assert.equal(config.groupsClaim, 'roles')
    assert.equal(config.groupsScope, 'groups')
  })
})

describe('OidcPreset', () => {
  test('authorizationUrl/profile/logoutUrl delegate to an internal OidcAuthentication, not reimplemented protocol calls', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://issuer.example/authorize?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'sub-123',
      email: 'person@example.com',
      name: 'A Person'
    }))
    const logoutUrlMock = mock.method(OidcAuthentication.prototype, 'logoutUrl', () => null)

    try {
      const preset = new OidcPreset(
        'strategy-1',
        { domain: 'something.auth0.com', clientId: 'abc', clientSecret: 'xyz' },
        { issuer: (c) => `https://${c.domain}/` }
      )

      const flow = {
        redirectUri: 'https://wiki.example/cb',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }
      const url = await preset.authorizationUrl(flow)
      assert.equal(url, 'https://issuer.example/authorize?state=xyz')
      assert.equal(authorizationUrlMock.mock.callCount(), 1)
      assert.deepEqual(authorizationUrlMock.mock.calls[0].arguments[0], flow)

      const profile = await preset.profile({
        ...flow,
        currentUrl: 'https://wiki.example/cb?code=1'
      })
      assert.deepEqual(profile, { id: 'sub-123', email: 'person@example.com', name: 'A Person' })
      assert.equal(profileMock.mock.callCount(), 1)

      assert.equal(preset.logoutUrl(), null)
      assert.equal(logoutUrlMock.mock.callCount(), 1)
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
      logoutUrlMock.mock.restore()
    }
  })

  test('the internal OidcAuthentication is built from the templated config, not the raw admin config', () => {
    const preset = new OidcPreset(
      'strategy-1',
      { domain: 'something.auth0.com', clientId: 'abc', clientSecret: 'xyz' },
      { issuer: (c) => `https://${c.domain}/`, scopes: 'openid profile email' }
    )
    const inner = (preset as unknown as { inner: OidcAuthentication }).inner
    assert.ok(inner instanceof OidcAuthentication)
    assert.equal(inner.conf.issuer, 'https://something.auth0.com/')
    assert.equal(inner.conf.scopes, 'openid profile email')
    assert.equal(inner.conf.clientId, 'abc')
  })
})
