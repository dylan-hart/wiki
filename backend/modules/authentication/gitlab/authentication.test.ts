import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import GitlabAuthentication from './authentication.ts'
import { OidcPreset } from '../oidc/preset.ts'
import OidcAuthentication from '../oidc/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('GitlabAuthentication', () => {
  test('is an OidcPreset, delegating protocol logic rather than copying it', () => {
    const gl = new GitlabAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    assert.ok(gl instanceof OidcPreset)
  })

  test('defaults the issuer to gitlab.com when no baseUrl is given', () => {
    const gl = new GitlabAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (gl as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://gitlab.com')
  })

  test('templates the issuer from baseUrl for a self-hosted instance', () => {
    const gl = new GitlabAuthentication('strategy-1', {
      baseUrl: 'https://gitlab.example.com',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (gl as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://gitlab.example.com')
  })

  test('trims a trailing slash off a self-hosted baseUrl', () => {
    const gl = new GitlabAuthentication('strategy-1', {
      baseUrl: 'https://gitlab.example.com/',
      clientId: 'abc',
      clientSecret: 'xyz'
    })
    const inner = (gl as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://gitlab.example.com')
  })

  test('authorizationUrl/profile forward to the internal OidcAuthentication', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://gitlab.com/oauth/authorize?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'abc123',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const gl = new GitlabAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const flow = {
        redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }
      assert.equal(await gl.authorizationUrl(flow), 'https://gitlab.com/oauth/authorize?state=xyz')
      assert.equal(authorizationUrlMock.mock.callCount(), 1)

      const profile = await gl.profile({ ...flow, currentUrl: 'https://wiki.example/cb?code=1' })
      assert.deepEqual(profile, { id: 'abc123', email: 'person@example.com', name: 'A Person' })
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
    }
  })

  test('carries mapGroups/groupsClaim/groupsScope through to the internal OidcAuthentication unchanged (OpenProject #826)', () => {
    const gl = new GitlabAuthentication('strategy-1', {
      clientId: 'abc',
      clientSecret: 'xyz',
      mapGroups: true,
      groupsClaim: 'groups_direct',
      groupsScope: ''
    })
    const inner = (gl as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.mapGroups, true)
    assert.equal(inner.conf.groupsClaim, 'groups_direct')
    assert.equal(inner.conf.groupsScope, '')
  })
})

describe('gitlab/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the branding convention', () => {
    assert.equal(def.key, 'gitlab')
    assert.equal(def.title, 'GitLab')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-gitlab.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares a baseUrl prop defaulting to gitlab.com, and no issuer prop', () => {
    assert.ok(def.props.baseUrl, 'expected a baseUrl prop')
    assert.equal(def.props.baseUrl.default, 'https://gitlab.com')
    assert.equal(def.props.issuer, undefined, 'issuer is templated, not admin-supplied')
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('declares mapGroups/groupsClaim/groupsScope props for group-claim mapping (OpenProject #826)', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
    assert.ok(def.props.groupsScope, 'expected a groupsScope prop')
  })

  test('the callback URL ref matches the shared convention', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
