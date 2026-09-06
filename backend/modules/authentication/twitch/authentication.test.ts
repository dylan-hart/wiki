import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import TwitchAuthentication from './authentication.ts'
import { OidcPreset } from '../oidc/preset.ts'
import OidcAuthentication from '../oidc/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('TwitchAuthentication', () => {
  test('is an OidcPreset, delegating protocol logic rather than copying it', () => {
    const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    assert.ok(tw instanceof OidcPreset)
  })

  test('the issuer is fixed to id.twitch.tv/oauth2, with no admin-supplied prop for it', () => {
    const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (tw as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://id.twitch.tv/oauth2')
  })

  test('scopes default to openid, since email needs the claims parameter rather than a scope', () => {
    const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (tw as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.scopes, 'openid')
  })

  test('requests the claims Twitch needs to put email on the ID token and userinfo response', () => {
    const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (tw as unknown as { inner: OidcAuthentication }).inner
    const claims = JSON.parse(inner.conf.extraAuthParams.claims)
    assert.deepEqual(claims, { id_token: { email: null }, userinfo: { email: null } })
  })

  test('the extraAuthParams claims value actually reaches the built authorization URL (real, unmocked authorizationUrl over a manual/non-discovery config)', async () => {
    const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (tw as unknown as { inner: OidcAuthentication }).inner
    // -> Force the manual (no-network) config path so this runs the real openid-client call.
    inner.conf.useDiscovery = false
    inner.conf.authorizationURL = 'https://id.twitch.tv/oauth2/authorize'
    inner.conf.tokenURL = 'https://id.twitch.tv/oauth2/token'
    inner.conf.jwksURL = 'https://id.twitch.tv/oauth2/keys'
    const url = new URL(
      await tw.authorizationUrl({
        redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      })
    )
    assert.equal(
      url.searchParams.get('claims'),
      '{"id_token":{"email":null},"userinfo":{"email":null}}'
    )
  })

  test('authorizationUrl/profile forward to the internal OidcAuthentication', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://id.twitch.tv/oauth2/authorize?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'abc123',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const flow = {
        redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }
      assert.equal(
        await tw.authorizationUrl(flow),
        'https://id.twitch.tv/oauth2/authorize?state=xyz'
      )
      assert.equal(authorizationUrlMock.mock.callCount(), 1)

      const profile = await tw.profile({ ...flow, currentUrl: 'https://wiki.example/cb?code=1' })
      assert.deepEqual(profile, {
        id: 'abc123',
        email: 'person@example.com',
        name: 'A Person',
        // -> the preset's own split of the one display string the OIDC mapping reports
        firstName: 'A',
        lastName: 'Person'
      })
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
    }
  })

  test('a Twitch handle is a mononym — no surname is invented out of it', async () => {
    // -> Twitch issues no given_name/family_name at all; `preferred_username` is a handle, so the
    //    split leaves `lastName` empty rather than manufacturing one.
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'abc123',
      email: 'person@example.com',
      name: 'somestreamer'
    }))
    try {
      const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const profile = await tw.profile({
        redirectUri: 'https://wiki.example/cb',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v',
        currentUrl: 'https://wiki.example/cb?code=1'
      })
      assert.equal(profile.firstName, 'somestreamer')
      assert.equal(profile.lastName, '')
    } finally {
      profileMock.mock.restore()
    }
  })

  test('name halves the OIDC mapping already established are kept, not re-guessed from the display string', async () => {
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'abc123',
      email: 'person@example.com',
      name: 'Ada Lovelace',
      firstName: 'Augusta',
      lastName: 'King'
    }))
    try {
      const tw = new TwitchAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const profile = await tw.profile({
        redirectUri: 'https://wiki.example/cb',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v',
        currentUrl: 'https://wiki.example/cb?code=1'
      })
      assert.equal(profile.firstName, 'Augusta')
      assert.equal(profile.lastName, 'King')
    } finally {
      profileMock.mock.restore()
    }
  })

  test('carries mapGroups/groupsClaim/groupsScope through to the internal OidcAuthentication unchanged (OpenProject #826), even though Twitch has no groups concept of its own', () => {
    const tw = new TwitchAuthentication('strategy-1', {
      clientId: 'abc',
      clientSecret: 'xyz',
      mapGroups: true,
      groupsClaim: 'groups'
    })
    const inner = (tw as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.mapGroups, true)
    assert.equal(inner.conf.groupsClaim, 'groups')
  })
})

describe('twitch/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the branding convention', () => {
    assert.equal(def.key, 'twitch')
    assert.equal(def.title, 'Twitch')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-twitch.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares no issuer, baseUrl, or org prop — the issuer is fixed', () => {
    assert.equal(def.props.issuer, undefined)
    assert.equal(def.props.baseUrl, undefined)
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('declares mapGroups/groupsClaim/groupsScope props for group-claim mapping (OpenProject #826), consistent with every other preset even though Twitch has no groups of its own', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
    assert.ok(def.props.groupsScope, 'expected a groupsScope prop')
  })

  test('the callback URL ref matches the shared convention', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
