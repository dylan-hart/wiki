import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import Auth0Authentication from './authentication.ts'
import { OidcPreset } from '../oidc/preset.ts'
import OidcAuthentication from '../oidc/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('Auth0Authentication', () => {
  test('is an OidcPreset, delegating protocol logic rather than copying it', () => {
    const auth0 = new Auth0Authentication('strategy-1', {
      domain: 'something.auth0.com',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    assert.ok(auth0 instanceof OidcPreset)
  })

  test('templates the issuer from the domain prop, e.g. something.auth0.com -> https://something.auth0.com/', () => {
    const auth0 = new Auth0Authentication('strategy-1', {
      domain: 'something.auth0.com',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (auth0 as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://something.auth0.com/')
  })

  test('authorizationUrl/profile forward to the internal OidcAuthentication (no local client.discovery/buildAuthorizationUrl/authorizationCodeGrant)', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://something.auth0.com/authorize?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'auth0|abc123',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const auth0 = new Auth0Authentication('strategy-1', {
        domain: 'something.auth0.com',
        clientId: 'abc',
        clientSecret: 'xyz'
      })
      const flow = {
        redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }
      assert.equal(
        await auth0.authorizationUrl(flow),
        'https://something.auth0.com/authorize?state=xyz'
      )
      assert.equal(authorizationUrlMock.mock.callCount(), 1)

      const profile = await auth0.profile({ ...flow, currentUrl: 'https://wiki.example/cb?code=1' })
      assert.deepEqual(profile, {
        id: 'auth0|abc123',
        email: 'person@example.com',
        name: 'A Person'
      })
      assert.equal(profileMock.mock.callCount(), 1)
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
    }
  })

  test('a strategy missing clientId/clientSecret fails the same way the generic OIDC module fails, not silently', async () => {
    const auth0 = new Auth0Authentication('strategy-1', { domain: 'something.auth0.com' })
    await assert.rejects(
      auth0.authorizationUrl({
        redirectUri: 'https://wiki.example/cb',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }),
      /ERR_STRATEGY_MISCONFIGURED/
    )
  })
})

describe('auth0/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the github/google/oidc branding convention', () => {
    assert.equal(def.key, 'auth0')
    assert.equal(def.title, 'Auth0')
    assert.equal(def.logo, 'https://static.requarks.io/logo/auth0.svg')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-auth0.svg')
    assert.equal(def.color, 'deep-orange')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares a domain prop, and no issuer prop the admin would have to fill in', () => {
    assert.ok(def.props.domain, 'expected a domain prop')
    assert.equal(def.props.issuer, undefined, 'issuer is templated, not admin-supplied')
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('the callback URL ref matches the {host}/_api/auth/{id}/callback convention every module uses', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
