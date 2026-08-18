import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import OktaAuthentication from './authentication.ts'
import { OidcPreset } from '../oidc/preset.ts'
import OidcAuthentication from '../oidc/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('OktaAuthentication', () => {
  test('is an OidcPreset, delegating protocol logic rather than copying it', () => {
    const okta = new OktaAuthentication('strategy-1', {
      orgUrl: 'https://dev-12345.okta.com',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    assert.ok(okta instanceof OidcPreset)
  })

  test('templates the issuer straight from the org URL prop', () => {
    const okta = new OktaAuthentication('strategy-1', {
      orgUrl: 'https://dev-12345.okta.com',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (okta as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://dev-12345.okta.com')
  })

  test('trims a trailing slash off the org URL before templating the issuer', () => {
    const okta = new OktaAuthentication('strategy-1', {
      orgUrl: 'https://dev-12345.okta.com/',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (okta as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://dev-12345.okta.com')
  })

  test('authorizationUrl/profile forward to the internal OidcAuthentication', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://dev-12345.okta.com/oauth2/v1/authorize?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'abc123',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const okta = new OktaAuthentication('strategy-1', {
        orgUrl: 'https://dev-12345.okta.com',
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
        await okta.authorizationUrl(flow),
        'https://dev-12345.okta.com/oauth2/v1/authorize?state=xyz'
      )
      assert.equal(authorizationUrlMock.mock.callCount(), 1)

      const profile = await okta.profile({ ...flow, currentUrl: 'https://wiki.example/cb?code=1' })
      assert.deepEqual(profile, { id: 'abc123', email: 'person@example.com', name: 'A Person' })
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
    }
  })
})

describe('okta/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the branding convention', () => {
    assert.equal(def.key, 'okta')
    assert.equal(def.title, 'Okta')
    assert.equal(def.logo, 'https://static.requarks.io/logo/okta.svg')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-okta.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test("declares an orgUrl prop matching 2.5.x's Audience/Org URL field, and no issuer prop", () => {
    assert.ok(def.props.orgUrl, 'expected an orgUrl prop')
    assert.equal(def.props.issuer, undefined, 'issuer is templated, not admin-supplied')
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('the callback URL ref matches the shared convention', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
