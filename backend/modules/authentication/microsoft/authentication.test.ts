import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import MicrosoftAuthentication from './authentication.ts'
import { OidcPreset } from '../oidc/preset.ts'
import OidcAuthentication from '../oidc/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('MicrosoftAuthentication', () => {
  test('is an OidcPreset, delegating protocol logic rather than copying it', () => {
    const ms = new MicrosoftAuthentication('strategy-1', {
      tenantId: 'contoso.onmicrosoft.com',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    assert.ok(ms instanceof OidcPreset)
  })

  test('templates the issuer from the tenant ID prop', () => {
    const ms = new MicrosoftAuthentication('strategy-1', {
      tenantId: 'contoso.onmicrosoft.com',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (ms as unknown as { inner: OidcAuthentication }).inner
    assert.equal(
      inner.conf.issuer,
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0'
    )
  })

  test('defaults tenantId to "common" (multi-tenant) when left blank', () => {
    const ms = new MicrosoftAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (ms as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://login.microsoftonline.com/common/v2.0')
  })

  test('authorizationUrl/profile forward to the internal OidcAuthentication', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'abc123',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const ms = new MicrosoftAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const flow = {
        redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }
      assert.equal(
        await ms.authorizationUrl(flow),
        'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=xyz'
      )
      assert.equal(authorizationUrlMock.mock.callCount(), 1)

      const profile = await ms.profile({ ...flow, currentUrl: 'https://wiki.example/cb?code=1' })
      assert.deepEqual(profile, { id: 'abc123', email: 'person@example.com', name: 'A Person' })
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
    }
  })
})

describe('microsoft/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the branding convention', () => {
    assert.equal(def.key, 'microsoft')
    assert.equal(def.title, 'Microsoft')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-microsoft.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares a tenantId prop defaulting to common, and no issuer prop', () => {
    assert.ok(def.props.tenantId, 'expected a tenantId prop')
    assert.equal(def.props.tenantId.default, 'common')
    assert.equal(def.props.issuer, undefined, 'issuer is templated, not admin-supplied')
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('the callback URL ref matches the shared convention', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
