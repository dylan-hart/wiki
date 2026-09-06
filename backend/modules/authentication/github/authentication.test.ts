import { describe, test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import GitHubAuthentication from './authentication.ts'

/**
 * GitHub is written with bare `fetch` and no client library (see the module's own doc comment), so
 * this suite drives it by stubbing `globalThis.fetch` with a small fake of the three endpoints a
 * login actually touches: the token exchange, `/user` and `/user/emails`.
 *
 * It was added for the first/last name split (OpenProject #2641) — GitHub reports one free-text
 * `name` and no separated halves, so the split is the only source there is — and covers the
 * surrounding profile mapping alongside it, since there was no co-located test file here before.
 */

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
}

describe('GitHubAuthentication', () => {
  let fetchMock: ReturnType<typeof mock.method> | undefined

  afterEach(() => {
    fetchMock?.mock.restore()
    fetchMock = undefined
  })

  /** The three endpoints a successful login walks, with one verified primary address. */
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
    // -> the whole remainder, not just the next word
    assert.equal(profile.lastName, 'Byron King')
  })

  test('a one-word profile name stays a mononym — no surname is invented for it', async () => {
    mockGitHub({ id: 1, login: 'octocat', name: 'Prince' })
    const profile = await strategy().profile({ ...flow, currentUrl: '', code: 'the-code' })
    assert.equal(profile.firstName, 'Prince')
    assert.equal(profile.lastName, '')
  })

  test('an account with no profile name falls back to the login, as a mononym', async () => {
    // -> GitHub's `name` is optional and frequently null; `login` is a handle, not a name, so it
    //    lands whole in `firstName` with nothing manufactured for `lastName`.
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
})
