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
      assert.deepEqual(profile, { id: 'U0123456', email: 'person@example.com', name: 'A Person' })
      assert.equal(profileMock.mock.callCount(), 1)
    } finally {
      authorizationUrlMock.mock.restore()
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
