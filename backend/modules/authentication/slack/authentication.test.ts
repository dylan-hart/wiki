import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import SlackAuthentication from './authentication.ts'
import { OidcPreset } from '../oidc/preset.ts'
import OidcAuthentication from '../oidc/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/*
 * Slack was reclassified from OAuth2-only to OIDC during this task: "Sign in with Slack" publishes
 * `/.well-known/openid-configuration` and issues a verifiable ID token (confirmed live against
 * https://slack.com/.well-known/openid-configuration and https://docs.slack.dev/authentication/sign-in-with-slack/
 * — see docs/auth-provider-audit.md). So, like Auth0/Okta/Twitch, this is an `OidcPreset` — no local
 * `client.discovery`/`buildAuthorizationUrl`/`authorizationCodeGrant` calls.
 */
describe('SlackAuthentication', () => {
  test('is an OidcPreset, delegating protocol logic rather than copying it', () => {
    const slack = new SlackAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    assert.ok(slack instanceof OidcPreset)
  })

  test('fixes the issuer to https://slack.com — one Slack, no per-tenant domain prop', () => {
    const slack = new SlackAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (slack as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.issuer, 'https://slack.com')
  })

  test('requests the openid email profile scopes "Sign in with Slack" documents', () => {
    const slack = new SlackAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (slack as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.scopes, 'openid email profile')
  })

  test('sends no extra authorization param when no teamId is configured', () => {
    const slack = new SlackAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
    const inner = (slack as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.extraAuthParams, undefined)
  })

  test('restricts the authorization request to one workspace via the `team` parameter when teamId is configured', () => {
    const slack = new SlackAuthentication('strategy-1', {
      clientId: 'abc',
      clientSecret: 'xyz',
      teamId: 'T0123456'
    })
    const inner = (slack as unknown as { inner: OidcAuthentication }).inner
    assert.deepEqual(inner.conf.extraAuthParams, { team: 'T0123456' })
  })

  test('authorizationUrl/profile forward to the internal OidcAuthentication (no local protocol calls)', async () => {
    const authorizationUrlMock = mock.method(
      OidcAuthentication.prototype,
      'authorizationUrl',
      async () => 'https://slack.com/openid/connect/authorize?state=xyz'
    )
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'U0123456',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const slack = new SlackAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const flow = {
        redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }
      assert.equal(
        await slack.authorizationUrl(flow),
        'https://slack.com/openid/connect/authorize?state=xyz'
      )
      assert.equal(authorizationUrlMock.mock.callCount(), 1)

      const profile = await slack.profile({ ...flow, currentUrl: 'https://wiki.example/cb?code=1' })
      assert.deepEqual(profile, {
        id: 'U0123456',
        email: 'person@example.com',
        name: 'A Person',
        // -> the preset's own split of the one display string the OIDC mapping reports
        firstName: 'A',
        lastName: 'Person'
      })
      assert.equal(profileMock.mock.callCount(), 1)
    } finally {
      authorizationUrlMock.mock.restore()
      profileMock.mock.restore()
    }
  })

  test('a one-word display name stays a mononym — no surname is invented for it', async () => {
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'U0123456',
      email: 'person@example.com',
      name: 'Prince'
    }))
    try {
      const slack = new SlackAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const profile = await slack.profile({
        redirectUri: 'https://wiki.example/cb',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v',
        currentUrl: 'https://wiki.example/cb?code=1'
      })
      assert.equal(profile.firstName, 'Prince')
      assert.equal(profile.lastName, '')
    } finally {
      profileMock.mock.restore()
    }
  })

  test('name halves the OIDC mapping already established are kept, not re-guessed from the display string', async () => {
    // -> Slack publishes given_name/family_name under the `profile` scope this preset requests. If the
    //    shared OIDC mapping starts reading them, what the provider actually said has to survive this
    //    preset untouched — the naive split is a fallback, never an overwrite.
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'U0123456',
      email: 'person@example.com',
      name: 'Ada Lovelace',
      firstName: 'Augusta',
      lastName: 'King'
    }))
    try {
      const slack = new SlackAuthentication('strategy-1', { clientId: 'abc', clientSecret: 'xyz' })
      const profile = await slack.profile({
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

  test("the display-name split is this preset's own, not something OidcPreset does for every preset", async () => {
    /*
      Blast-radius guard. `OidcPreset` is the shared base behind auth0, okta, microsoft, keycloak,
      gitlab, twitch and slack. A display-name split placed on it would fire for the five providers
      that do report real `given_name`/`family_name` claims and silently pre-empt them, so the
      fallback belongs on the presets whose provider issues one string and nothing else.
    */
    const profileMock = mock.method(OidcAuthentication.prototype, 'profile', async () => ({
      id: 'U0123456',
      email: 'person@example.com',
      name: 'A Person'
    }))
    try {
      const bare = new OidcPreset(
        'strategy-1',
        { clientId: 'abc', clientSecret: 'xyz' },
        { issuer: () => 'https://provider.example' }
      )
      const profile = await bare.profile({
        redirectUri: 'https://wiki.example/cb',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v',
        currentUrl: 'https://wiki.example/cb?code=1'
      })
      assert.ok(!profile.firstName, 'OidcPreset itself must not split the display name')
      assert.ok(!profile.lastName, 'OidcPreset itself must not split the display name')
    } finally {
      profileMock.mock.restore()
    }
  })

  test('a strategy missing clientId/clientSecret fails the same way the generic OIDC module fails, not silently', async () => {
    const slack = new SlackAuthentication('strategy-1', {})
    await assert.rejects(
      slack.authorizationUrl({
        redirectUri: 'https://wiki.example/cb',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v'
      }),
      /ERR_STRATEGY_MISCONFIGURED/
    )
  })

  test('carries mapGroups/groupsClaim/groupsScope through to the internal OidcAuthentication unchanged (OpenProject #826), even though Slack has no groups concept of its own', () => {
    const slack = new SlackAuthentication('strategy-1', {
      clientId: 'abc',
      clientSecret: 'xyz',
      mapGroups: true,
      groupsClaim: 'groups'
    })
    const inner = (slack as unknown as { inner: OidcAuthentication }).inner
    assert.equal(inner.conf.mapGroups, true)
    assert.equal(inner.conf.groupsClaim, 'groups')
  })
})

describe('slack/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the github/google/oidc branding convention', () => {
    assert.equal(def.key, 'slack')
    assert.equal(def.title, 'Slack')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-slack.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares no domain/issuer prop the admin would have to fill in — Slack has one fixed issuer', () => {
    assert.equal(def.props.domain, undefined)
    assert.equal(def.props.issuer, undefined)
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
  })

  test('declares an optional teamId prop for the workspace restriction', () => {
    assert.ok(def.props.teamId, 'expected a teamId prop')
  })

  test('declares mapGroups/groupsClaim/groupsScope props for group-claim mapping (OpenProject #826), consistent with every other preset even though Slack has no groups of its own', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
    assert.ok(def.props.groupsScope, 'expected a groupsScope prop')
  })

  test('the callback URL ref matches the {host}/_api/auth/{id}/callback convention every module uses', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
