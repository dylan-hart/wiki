import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { buildOidcConfig, OidcPreset } from './preset.ts'
import OidcAuthentication from './authentication.ts'

/**
 * Covers the composition pattern from Task 437: a branded preset must not re-hardcode
 * `client.discovery`/`buildAuthorizationUrl`/`authorizationCodeGrant` the way
 * `google/authentication.ts` does. `buildOidcConfig` is asserted directly (pure, no network); the
 * delegation itself is asserted by replacing `OidcAuthentication.prototype` methods with mocks and
 * checking `OidcPreset` forwards to the exact same instance it built from that merge — never touching
 * `openid-client` or the network.
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
    // -> Not fixed by this template, so the admin config's own value survives
    assert.equal(config.displayNameClaim, 'name')
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
    // -> `inner` is private at the type level but this asserts the real runtime shape
    const inner = (preset as unknown as { inner: OidcAuthentication }).inner
    assert.ok(inner instanceof OidcAuthentication)
    assert.equal(inner.conf.issuer, 'https://something.auth0.com/')
    assert.equal(inner.conf.scopes, 'openid profile email')
    assert.equal(inner.conf.clientId, 'abc')
  })
})
