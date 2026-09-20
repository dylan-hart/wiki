import { describe, test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import GitHubAuthentication from './authentication.ts'

const flow = {
  redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
  state: 'the-state',
  nonce: 'unused',
  codeVerifier: 'unused'
}

interface FakeAccount {
  id?: number | string
  login?: string
  name?: string | null
  avatar_url?: string | null
}

describe('GitHubAuthentication', () => {
  let fetchMock: ReturnType<typeof mock.method> | undefined

  afterEach(() => {
    fetchMock?.mock.restore()
    fetchMock = undefined
  })

  function mockGitHub(account: FakeAccount, email = 'octocat@example.com') {
    fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
      const url = String(input)
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify(account), { status: 200 })
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(JSON.stringify([{ email, primary: true, verified: true }]), {
          status: 200
        })
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    return fetchMock
  }

  function strategy(conf: Record<string, any> = {}) {
    return new GitHubAuthentication('strategy-1', {
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      ...conf
    })
  }

  test('maps id/email/name from the account and the verified primary address', async () => {
    mockGitHub({ id: 583231, login: 'octocat', name: 'Ada Lovelace' })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.deepEqual(profile, {
      id: '583231',
      email: 'octocat@example.com',
      name: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
  })

  test('splits the profile name into the two name fields this instance stores', async () => {
    mockGitHub({ id: 1, login: 'octocat', name: 'Ada Byron King' })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.equal(profile.firstName, 'Ada')
    assert.equal(profile.lastName, 'Byron King')
  })

  test('a one-word profile name stays a mononym — no surname is invented for it', async () => {
    mockGitHub({ id: 1, login: 'octocat', name: 'Prince' })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.equal(profile.firstName, 'Prince')
    assert.equal(profile.lastName, '')
  })

  test('an account with no profile name falls back to the login, as a mononym', async () => {
    // -> GitHub's `name` is optional and frequently null; `login` is a handle, not a name.
    mockGitHub({ id: 1, login: 'octocat', name: null })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.equal(profile.name, 'octocat')
    assert.equal(profile.firstName, 'octocat')
    assert.equal(profile.lastName, '')
  })

  test('surrounding whitespace on the profile name does not leak into either half', async () => {
    mockGitHub({ id: 1, login: 'octocat', name: '  Ada Lovelace  ' })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.equal(profile.firstName, 'Ada')
    assert.equal(profile.lastName, 'Lovelace')
  })

  test('an account with no verified primary address is refused rather than mapped', async () => {
    fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
      const url = String(input)
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 1, login: 'octocat', name: 'Ada Lovelace' }), {
          status: 200
        })
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify([{ email: 'octocat@example.com', primary: true, verified: false }]),
          { status: 200 }
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    await assert.rejects(
      strategy().profile({ ...flow, currentUrl: '', code: 'the-code' }),
      /ERR_NO_VERIFIED_EMAIL_FROM_PROVIDER/
    )
  })

  test('a strategy missing clientId/clientSecret refuses to build an authorization URL', async () => {
    const github = new GitHubAuthentication('strategy-1', {})
    await assert.rejects(github.authorizationUrl(flow), /ERR_STRATEGY_MISCONFIGURED/)
  })

  test('maps avatar_url into the profile picture', async () => {
    mockGitHub({
      id: 1,
      login: 'octocat',
      name: 'Ada Lovelace',
      avatar_url: 'https://avatars.githubusercontent.com/u/583231'
    })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.equal(profile.picture, 'https://avatars.githubusercontent.com/u/583231')
  })

  test('an account with no avatar_url leaves the picture key off the profile', async () => {
    mockGitHub({ id: 1, login: 'octocat', name: 'Ada Lovelace', avatar_url: null })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.equal('picture' in profile, false)
  })

  describe('team groups', () => {
    type TeamsHandler = (url: string) => Response

    const team = (org: string, slug: string) => ({ slug, organization: { login: org } })

    function mockWithTeams(onTeams: TeamsHandler, apiBase = 'https://api.github.com') {
      const teamUrls: string[] = []
      const webBase = apiBase.endsWith('/api/v3') ? apiBase.slice(0, -7) : 'https://github.com'
      fetchMock = mock.method(globalThis, 'fetch', async (input: any) => {
        const url = String(input)
        if (url === `${webBase}/login/oauth/access_token`) {
          return new Response(JSON.stringify({ access_token: 'the-access-token' }), { status: 200 })
        }
        if (url === `${apiBase}/user`) {
          return new Response(JSON.stringify({ id: 1, login: 'octocat', name: 'Ada Lovelace' }))
        }
        if (url === `${apiBase}/user/emails`) {
          return new Response(
            JSON.stringify([{ email: 'octocat@example.com', primary: true, verified: true }])
          )
        }
        if (url.startsWith(`${apiBase}/orgs/`)) {
          return new Response(null, { status: 204 })
        }
        if (url.startsWith(`${apiBase}/user/teams`)) {
          teamUrls.push(url)
          return onTeams(url)
        }
        throw new Error(`unexpected fetch to ${url}`)
      })
      return teamUrls
    }

    const run = (conf: Record<string, any>) =>
      strategy(conf).profile({ ...flow, currentUrl: '', code: 'the-code' })

    test('mapGroups off leaves the groups key off and never asks for teams', async () => {
      const teamUrls = mockWithTeams(() => new Response('[]'))
      const profile = await run({})
      assert.equal('groups' in profile, false)
      assert.deepEqual(teamUrls, [])
    })

    test('mapGroups on reports every team as <org>/<slug>', async () => {
      const teamUrls = mockWithTeams(
        () => new Response(JSON.stringify([team('acme', 'core'), team('other', 'core')]))
      )
      const profile = await run({ mapGroups: true })
      assert.deepEqual(profile.groups, ['acme/core', 'other/core'])
      assert.deepEqual(teamUrls, ['https://api.github.com/user/teams?per_page=100'])
    })

    test('mapGroups on with no teams answers an empty list, not an absent one', async () => {
      mockWithTeams(() => new Response('[]'))
      const profile = await run({ mapGroups: true })
      assert.deepEqual(profile.groups, [])
    })

    test('allowedOrganization narrows the teams to that organization, case-insensitively', async () => {
      mockWithTeams(
        () => new Response(JSON.stringify([team('Acme', 'core'), team('other', 'core')]))
      )
      const profile = await run({ mapGroups: true, allowedOrganization: 'acme' })
      assert.deepEqual(profile.groups, ['Acme/core'])
    })

    test('follows Link pagination until there is no next page', async () => {
      const teamUrls = mockWithTeams((url) => {
        if (url.endsWith('per_page=100')) {
          return new Response(JSON.stringify([team('acme', 'one')]), {
            headers: {
              Link: '<https://api.github.com/user/teams?per_page=100&page=2>; rel="next", <https://api.github.com/user/teams?per_page=100&page=2>; rel="last"'
            }
          })
        }
        return new Response(JSON.stringify([team('acme', 'two')]), {
          headers: {
            Link: '<https://api.github.com/user/teams?per_page=100&page=1>; rel="prev", <https://api.github.com/user/teams?per_page=100&page=1>; rel="first"'
          }
        })
      })
      const profile = await run({ mapGroups: true })
      assert.deepEqual(profile.groups, ['acme/one', 'acme/two'])
      assert.equal(teamUrls.length, 2)
    })

    test('refuses to follow a next link that leaves the API host', async () => {
      const teamUrls = mockWithTeams(
        () =>
          new Response(JSON.stringify([team('acme', 'one')]), {
            headers: { Link: '<https://evil.example/user/teams?page=2>; rel="next"' }
          })
      )
      await assert.rejects(run({ mapGroups: true }), /ERR_PROVIDER_REQUEST_FAILED/)
      assert.equal(teamUrls.length, 1)
    })

    test('asks a GitHub Enterprise Server host under /api/v3', async () => {
      const teamUrls = mockWithTeams(
        () => new Response(JSON.stringify([team('acme', 'core')])),
        'https://ghe.example.com/api/v3'
      )
      const profile = await run({ mapGroups: true, enterpriseHost: 'ghe.example.com' })
      assert.deepEqual(profile.groups, ['acme/core'])
      assert.deepEqual(teamUrls, ['https://ghe.example.com/api/v3/user/teams?per_page=100'])
    })

    test('a failing teams call throws instead of answering an empty list', async () => {
      mockWithTeams(() => new Response('{}', { status: 502 }))
      await assert.rejects(run({ mapGroups: true }), /ERR_PROVIDER_REQUEST_FAILED/)
    })

    test('authorizationUrl asks for read:org when either allowedOrganization or mapGroups is set', async () => {
      const scope = async (conf: Record<string, any>) =>
        new URL(await strategy(conf).authorizationUrl(flow)).searchParams.get('scope')
      assert.equal(await scope({}), 'read:user user:email')
      assert.equal(await scope({ mapGroups: true }), 'read:user user:email read:org')
      assert.equal(await scope({ allowedOrganization: 'acme' }), 'read:user user:email read:org')
    })
  })
})
