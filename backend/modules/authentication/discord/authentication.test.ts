import { describe, test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import DiscordAuthentication from './authentication.ts'
import OAuth2Authentication from '../oauth2/authentication.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const flow = {
  redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
  state: 'the-state',
  nonce: 'unused',
  codeVerifier: 'unused'
}

describe('DiscordAuthentication', () => {
  test('is an OAuth2Authentication, delegating the token exchange rather than reimplementing it', () => {
    const discord = new DiscordAuthentication('strategy-1', {
      clientId: 'client-abc',
      clientSecret: 'secret-xyz'
    })
    assert.ok(discord instanceof OAuth2Authentication)
  })

  describe('authorizationUrl', () => {
    test('fixes the authorization URL and scope — Discord has one fixed set of endpoints', async () => {
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz'
      })
      const url = new URL(await discord.authorizationUrl(flow))
      assert.equal(url.origin + url.pathname, 'https://discord.com/api/oauth2/authorize')
      assert.equal(url.searchParams.get('scope'), 'identify email')
      assert.equal(url.searchParams.get('client_id'), 'client-abc')
      assert.equal(url.searchParams.get('redirect_uri'), flow.redirectUri)
    })

    test('adds the `guilds` scope only when a guildId restriction is configured', async () => {
      const withoutGuild = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz'
      })
      const urlWithout = new URL(await withoutGuild.authorizationUrl(flow))
      assert.equal(urlWithout.searchParams.get('scope'), 'identify email')

      const withGuild = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        guildId: '123456789012345678'
      })
      const urlWith = new URL(await withGuild.authorizationUrl(flow))
      assert.equal(urlWith.searchParams.get('scope'), 'identify email guilds')
    })

    test('a strategy missing clientId/clientSecret fails the same way the generic module fails', async () => {
      const discord = new DiscordAuthentication('strategy-1', {})
      await assert.rejects(discord.authorizationUrl(flow), /ERR_STRATEGY_MISCONFIGURED/)
    })
  })

  describe('profile', () => {
    let fetchMock: ReturnType<typeof mock.method>

    afterEach(() => {
      fetchMock?.mock.restore()
    })

    function mockTokenExchange(
      extra: (url: string, init: any) => Response | undefined = () => undefined
    ) {
      return mock.method(globalThis, 'fetch', async (input: any, init: any) => {
        const url = String(input)
        const extraResp = extra(url, init)
        if (extraResp) return extraResp
        if (url === 'https://discord.com/api/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me') {
          return new Response(
            JSON.stringify({
              id: '987654321098765432',
              username: 'octocat',
              global_name: 'The Octocat',
              email: 'octocat@example.com',
              verified: true
            }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
    }

    test('maps id/email/username from /users/@me when no guildId restriction is configured', async () => {
      fetchMock = mockTokenExchange()
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz'
      })
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile, {
        id: '987654321098765432',
        email: 'octocat@example.com',
        name: 'octocat'
      })
      // -> no guildId configured, so /users/@me/guilds must never be called
      assert.equal(
        fetchMock.mock.calls.some(
          (c) => String(c.arguments[0]) === 'https://discord.com/api/users/@me/guilds'
        ),
        false
      )
    })

    test('signs the user in when guildId is configured and the guild appears in /users/@me/guilds', async () => {
      fetchMock = mockTokenExchange((url) => {
        if (url === 'https://discord.com/api/users/@me/guilds') {
          return new Response(
            JSON.stringify([
              { id: '111111111111111111', name: 'Some Other Server' },
              { id: '222222222222222222', name: 'The Required Server' }
            ]),
            { status: 200 }
          )
        }
        return undefined
      })
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        guildId: '222222222222222222'
      })
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.id, '987654321098765432')
    })

    test('throws ERR_LOGIN_RESTRICTED when guildId is configured and the user is not a member of that guild', async () => {
      fetchMock = mockTokenExchange((url) => {
        if (url === 'https://discord.com/api/users/@me/guilds') {
          return new Response(JSON.stringify([{ id: '111111111111111111', name: 'Not It' }]), {
            status: 200
          })
        }
        return undefined
      })
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        guildId: '222222222222222222'
      })
      await assert.rejects(
        discord.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_LOGIN_RESTRICTED/
      )
    })

    test('throws ERR_LOGIN_RESTRICTED when the guild membership check itself fails', async () => {
      fetchMock = mockTokenExchange((url) => {
        if (url === 'https://discord.com/api/users/@me/guilds') {
          return new Response('rate limited', { status: 429 })
        }
        return undefined
      })
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        guildId: '222222222222222222'
      })
      await assert.rejects(
        discord.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_LOGIN_RESTRICTED/
      )
    })

    test('the guild check runs before the userinfo call, using the same access token, and not at all without guildId', async () => {
      const calls: string[] = []
      fetchMock = mock.method(globalThis, 'fetch', async (input: any, init: any) => {
        const url = String(input)
        calls.push(url)
        if (url === 'https://discord.com/api/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me/guilds') {
          assert.equal(init.headers.Authorization, 'Bearer the-access-token')
          return new Response(JSON.stringify([{ id: '222222222222222222' }]), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me') {
          assert.equal(init.headers.Authorization, 'Bearer the-access-token')
          return new Response(JSON.stringify({ id: '1', username: 'u', email: 'u@example.com' }), {
            status: 200
          })
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        guildId: '222222222222222222'
      })
      await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(calls, [
        'https://discord.com/api/oauth2/token',
        'https://discord.com/api/users/@me/guilds',
        'https://discord.com/api/users/@me'
      ])
    })

    /**
     * Discord inherits group-claim mapping from the base `OAuth2Authentication.mapProfile()` rather
     * than reimplementing it — this is the same consistency guarantee `oidc/preset.ts`'s branded
     * presets get from `OidcAuthentication` (OpenProject #826), just for the OAuth2-only side of the
     * module family. Stock Discord reports no such field on `/users/@me`, so this exercises the
     * mapping mechanism itself, not a real Discord claim.
     */
    test('maps the configured groupsClaim onto profile.groups when mapGroups is on', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://discord.com/api/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me') {
          return new Response(
            JSON.stringify({
              id: '987654321098765432',
              username: 'octocat',
              email: 'octocat@example.com',
              roles: ['moderator', 'editor']
            }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        mapGroups: true,
        groupsClaim: 'roles'
      })
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, ['moderator', 'editor'])
    })

    test('leaves profile.groups absent when mapGroups is off', async () => {
      fetchMock = mockTokenExchange()
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz'
      })
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal('groups' in profile, false)
    })

    /**
     * Discord's user object carries its own sibling `verified` boolean alongside `email` -- previously
     * fetched and silently discarded. `buildDiscordConfig()` now names it as `emailVerifiedClaim`, so
     * this is the same check `oauth2/authentication.test.ts` exercises generically, proven here against
     * Discord's actual field name.
     */
    test('throws ERR_EMAIL_NOT_VERIFIED when Discord reports verified: false', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://discord.com/api/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me') {
          return new Response(
            JSON.stringify({
              id: '987654321098765432',
              username: 'octocat',
              email: 'octocat@example.com',
              verified: false
            }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz'
      })
      await assert.rejects(
        discord.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        /ERR_EMAIL_NOT_VERIFIED/
      )
    })

    test('signs in normally when Discord reports verified: true, as the fixture responses above already do', async () => {
      fetchMock = mockTokenExchange()
      const discord = new DiscordAuthentication('strategy-1', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz'
      })
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.email, 'octocat@example.com')
    })
  })
})

describe('discord/definition.yml', () => {
  const def = load(readFileSync(path.join(__dirname, 'definition.yml'), 'utf-8')) as Record<
    string,
    any
  >

  test('follows the github/google/oidc branding convention', () => {
    assert.equal(def.key, 'discord')
    assert.equal(def.title, 'Discord')
    assert.equal(def.icon, '/_assets/icons/ultraviolet-discord.svg')
    assert.equal(def.isAvailable, true)
    assert.equal(def.usernameType, 'email')
  })

  test('declares no endpoint/scope/claim props — those are fixed by the module, only credentials and the guild restriction are admin-supplied', () => {
    assert.ok(def.props.clientId)
    assert.ok(def.props.clientSecret)
    assert.equal(def.props.clientSecret.sensitive, true)
    assert.ok(def.props.guildId, 'expected a guildId prop')
    for (const prop of ['authorizationURL', 'tokenURL', 'userInfoURL', 'scope']) {
      assert.equal(def.props[prop], undefined, `${prop} should be fixed, not admin-supplied`)
    }
  })

  test('declares mapGroups/groupsClaim props for group-claim mapping (OpenProject #826), consistent with every other preset even though stock Discord reports no such field', () => {
    assert.ok(def.props.mapGroups, 'expected a mapGroups prop')
    assert.ok(def.props.groupsClaim, 'expected a groupsClaim prop')
  })

  test('the callback URL ref matches the {host}/_api/auth/{id}/callback convention every module uses', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
