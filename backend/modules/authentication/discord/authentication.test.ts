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

  test('names `verified` as the email-verification claim, so a false /users/@me `verified` refuses the login', () => {
    const discord = new DiscordAuthentication('strategy-1', {
      clientId: 'client-abc',
      clientSecret: 'secret-xyz'
    })
    assert.equal(discord.conf.emailVerifiedClaim, 'verified')
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
        name: 'octocat',
        // -> One display string and no halves, so a single-word username stays a mononym.
        firstName: 'octocat',
        lastName: ''
      })
      assert.equal(
        fetchMock.mock.calls.some(
          (c) => String(c.arguments[0]) === 'https://discord.com/api/users/@me/guilds'
        ),
        false
      )
    })

    test('splits a multi-word display string into first and last name', async () => {
      // -> A real Discord `username` is normally one token; a spaced one is the only fixture that
      //    exercises the other side of the split through this preset's fixed `displayNameClaim`.
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://discord.com/api/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me') {
          return new Response(
            JSON.stringify({
              id: '1',
              username: 'Ada Lovelace',
              email: 'ada@example.com',
              verified: true
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
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.equal(profile.firstName, 'Ada')
      assert.equal(profile.lastName, 'Lovelace')
      assert.equal(profile.name, 'Ada Lovelace')
    })

    test("the display-name fallback is this preset's own, not the generic OAuth2 module's", () => {
      /*
        `OAuth2Authentication` backs every admin-configured plain OAuth2 strategy, so it may fill the
        name halves from configured claims but must never manufacture them out of the display string.
      */
      const generic = new OAuth2Authentication('strategy-2', {
        clientId: 'client-abc',
        clientSecret: 'secret-xyz',
        authorizationURL: 'https://provider.example/authorize',
        tokenURL: 'https://provider.example/token',
        userInfoURL: 'https://provider.example/userinfo'
      })
      const mapProfile = (generic as unknown as { mapProfile(info: Record<string, any>): any })
        .mapProfile
      const profile = mapProfile.call(generic, {
        id: '1',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com'
      })
      assert.equal(profile.name, 'Ada Lovelace')
      assert.ok(!profile.firstName, 'the generic OAuth2 mapping must not split the display name')
      assert.ok(!profile.lastName, 'the generic OAuth2 mapping must not split the display name')
    })

    test('throws ERR_EMAIL_NOT_VERIFIED when /users/@me reports verified: false', async () => {
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === 'https://discord.com/api/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me') {
          return new Response(
            JSON.stringify({ id: '1', username: 'u', email: 'u@example.com', verified: false }),
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

    const guildId = '222222222222222222'
    const botConf = {
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      guildId,
      mapGroups: true,
      botToken: 'the-bot-token'
    }

    function mockWithBot(bot: (url: string, init: any) => Response) {
      return mock.method(globalThis, 'fetch', async (input: any, init: any) => {
        const url = String(input)
        if (url.startsWith('https://discord.com/api/v10/')) {
          return bot(url, init)
        }
        if (url === 'https://discord.com/api/oauth2/token') {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me/guilds') {
          return new Response(JSON.stringify([{ id: guildId }]), { status: 200 })
        }
        if (url === 'https://discord.com/api/users/@me') {
          return new Response(
            JSON.stringify({
              id: '987654321098765432',
              username: 'octocat',
              email: 'octocat@example.com',
              verified: true,
              groups: ['from-a-claim']
            }),
            { status: 200 }
          )
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
    }

    const memberUrl = `https://discord.com/api/v10/guilds/${guildId}/members/987654321098765432`
    const rolesUrl = `https://discord.com/api/v10/guilds/${guildId}/roles`

    test('maps the member role ids to role names via the bot token when mapGroups is on', async () => {
      const botCalls: { url: string; auth: string }[] = []
      fetchMock = mockWithBot((url, init) => {
        botCalls.push({ url, auth: init.headers.Authorization })
        if (url === memberUrl) {
          return new Response(JSON.stringify({ roles: ['r2', 'r1', 'gone'] }), { status: 200 })
        }
        if (url === rolesUrl) {
          return new Response(
            JSON.stringify([
              { id: 'r1', name: 'Editors' },
              { id: 'r2', name: 'Moderators' },
              { id: 'r3', name: 'Unused' }
            ]),
            { status: 200 }
          )
        }
        throw new Error(`unexpected bot fetch to ${url}`)
      })
      const discord = new DiscordAuthentication('strategy-1', botConf)
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, ['Moderators', 'Editors'])
      assert.deepEqual(
        botCalls.map((c) => c.url),
        [memberUrl, rolesUrl]
      )
      assert.ok(botCalls.every((c) => c.auth === 'Bot the-bot-token'))
    })

    test('yields no groups, not an error, for a user who is not in the guild (404)', async () => {
      fetchMock = mockWithBot((url) => {
        if (url === memberUrl) {
          return new Response(JSON.stringify({ code: 10007 }), { status: 404 })
        }
        throw new Error(`unexpected bot fetch to ${url}`)
      })
      const discord = new DiscordAuthentication('strategy-1', botConf)
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, [])
    })

    test('a member with no roles yields an empty group list', async () => {
      fetchMock = mockWithBot((url) =>
        url === memberUrl
          ? new Response(JSON.stringify({ roles: [] }), { status: 200 })
          : new Response(JSON.stringify([{ id: 'r1', name: 'Editors' }]), { status: 200 })
      )
      const discord = new DiscordAuthentication('strategy-1', botConf)
      const profile = await discord.profile({ ...flow, currentUrl: '', code: 'the-code' })
      assert.deepEqual(profile.groups, [])
    })

    test('refuses as misconfigured, before any bot call, when the bot token or guild id is missing', async () => {
      for (const missing of ['botToken', 'guildId']) {
        fetchMock = mockWithBot(() => {
          throw new Error('the bot API must not be called')
        })
        const conf: Record<string, any> = { ...botConf }
        delete conf[missing]
        const discord = new DiscordAuthentication('strategy-1', conf)
        await assert.rejects(
          discord.profile({ ...flow, currentUrl: '', code: 'the-code' }),
          /ERR_STRATEGY_MISCONFIGURED/,
          missing
        )
        fetchMock.mock.restore()
      }
    })

    test('throws, rather than returning [], when a lookup fails, so an outage cannot revoke mapped groups', async () => {
      const failures: [string, (url: string) => Response][] = [
        ['member 429', () => new Response('rate limited', { status: 429 })],
        ['member 401', () => new Response('bad token', { status: 401 })],
        [
          'roles 500',
          (url) =>
            url === memberUrl
              ? new Response(JSON.stringify({ roles: ['r1'] }), { status: 200 })
              : new Response('boom', { status: 500 })
        ],
        [
          'member not JSON',
          (url) =>
            url === memberUrl
              ? new Response('<html>', { status: 200 })
              : new Response('[]', { status: 200 })
        ]
      ]
      for (const [label, bot] of failures) {
        fetchMock = mockWithBot(bot)
        const discord = new DiscordAuthentication('strategy-1', botConf)
        await assert.rejects(
          discord.profile({ ...flow, currentUrl: '', code: 'the-code' }),
          /ERR_GROUP_LOOKUP_FAILED/,
          label
        )
        fetchMock.mock.restore()
      }
    })

    test('never puts the bot token in an error', async () => {
      fetchMock = mockWithBot(() => new Response('nope', { status: 500 }))
      const discord = new DiscordAuthentication('strategy-1', botConf)
      await assert.rejects(
        discord.profile({ ...flow, currentUrl: '', code: 'the-code' }),
        (err: Error) => !err.message.includes('the-bot-token')
      )
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

  test('declares mapGroups and a sensitive botToken shown only when mapGroups is on, and no groupsClaim', () => {
    assert.equal(def.props.mapGroups.type, 'Boolean')
    assert.equal(def.props.mapGroups.default, false)
    assert.equal(def.props.botToken.type, 'String')
    assert.equal(def.props.botToken.sensitive, true)
    assert.deepEqual(def.props.botToken.if, [{ key: 'mapGroups', eq: true }])
    assert.equal(def.props.groupsClaim, undefined)
  })

  test('the callback URL ref matches the {host}/_api/auth/{id}/callback convention every module uses', () => {
    assert.equal(def.refs.callbackUrl.value, '{host}/_api/auth/{id}/callback')
  })
})
