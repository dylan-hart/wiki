import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import KeycloakAuthentication from './authentication.ts'
import { OidcPreset } from '../oidc/preset.ts'
import OidcAuthentication from '../oidc/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('KeycloakAuthentication', () => {
  test('is an OidcPreset, delegating protocol logic rather than copying it', () => {
    const kc = new KeycloakAuthentication('strategy-1', {
      baseUrl: 'https://sso.example.com',
      realm: 'wiki',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    assert.ok(kc instanceof OidcPreset)
  })

  test('templates the issuer from baseUrl + realm', () => {
    const kc = new KeycloakAuthentication('strategy-1', {
      baseUrl: 'https://sso.example.com',
      realm: 'wiki',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (kc as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://sso.example.com/realms/wiki')
  })

  test('trims a trailing slash off baseUrl before templating the issuer', () => {
    const kc = new KeycloakAuthentication('strategy-1', {
      baseUrl: 'https://sso.example.com/',
      realm: 'wiki',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (kc as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://sso.example.com/realms/wiki')
  })

  test('authorizationUrl/profile forward to the internal OidcAuthentication', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://sso.example.com/realms/wiki/protocol/openid-connect/auth?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'abc123',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const kc = new KeycloakAuthentication('strategy-1', {
        baseUrl: 'https://sso.example.com',
        realm: 'wiki',
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
        await kc.authorizationUrl(flow),
        'https://sso.example.com/realms/wiki/protocol/openid-connect/auth?state=xyz'
      )
      assert.equal(authorizationUrlMock.mock.callCount(), 1)

      const profile = await kc.profile({ ...flow, currentUrl: 'https://wiki.example/cb?code=1' })
      assert.deepEqual(profile, { id: 'abc123', email: 'person@example.com', name: 'A Person' })
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
    }
  })

  /**
   * This is the WP's own worked example: upstream's dedicated Keycloak strategy had no group-claim
   * mapping at all, unlike its Generic OpenID Connect strategy (OpenProject #826). This fork closes
   * that gap by routing Keycloak through the same `OidcAuthentication`/`mapOidcProfile` every other
   * OIDC preset uses, rather than special-casing it — so the fields simply pass through, same as any
   * other preset.
   */
  test('carries mapGroups/groupsClaim/groupsScope through to the internal OidcAuthentication unchanged, closing the gap Task/OpenProject #826 called out for Keycloak specifically', () => {
    const kc = new KeycloakAuthentication('strategy-1', {
      baseUrl: 'https://sso.example.com',
      realm: 'wiki',
      clientId: 'abc',
      clientSecret: 'xyz',
      mapGroups: true,
      groupsClaim: 'groups',
      groupsScope: 'groups'
    })
    const inner = (kc as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.mapGroups, true)
    assert.equal(inner.conf.groupsClaim, 'groups')
    assert.equal(inner.conf.groupsScope, 'groups')
  })
})

describe('keycloak/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the branding convention', () => {
    assert.equal(def.key, 'keycloak')
    assert.equal(def.title, 'Keycloak')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-keycloak.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares baseUrl + realm props, and no issuer prop', () => {
    assert.ok(def.props.baseUrl, 'expected a baseUrl prop')
    assert.ok(def.props.realm, 'expected a realm prop')
    assert.equal(def.props.issuer, undefined, 'issuer is templated, not admin-supplied')
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('declares mapGroups/groupsClaim/groupsScope props for group-claim mapping (OpenProject #826), defaulting groupsScope to the realm\'s well-known "groups" client scope', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
    assert.ok(def.props.groupsScope, 'expected a groupsScope prop')
    assert.equal(def.props.groupsScope.default, 'groups')
  })

  test('the baseUrl hint says plainly that this is the self-hosted preset', () => {
    const hint = String(def.props.baseUrl.hint).toLowerCase()
    assert.ok(
      hint.includes('self-hosted'),
      `expected the baseUrl hint to mention self-hosted, got: ${def.props.baseUrl.hint}`
    )
  })

  test('the callback URL ref matches the shared convention', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
