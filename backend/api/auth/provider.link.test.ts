import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fastifyFormBody from '@fastify/formbody'
import authenticationRoutes from './index.ts'
import { linkResultUrl } from './provider.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { installTestWiki } from '../../test/mocks.ts'

const withFormBody: FastifyPluginAsync = async (instance) => {
  await instance.register(fastifyFormBody)
  await instance.register(authenticationRoutes)
}

describe('linkResultUrl', () => {
  test('appends the result to a bare path', () => {
    assert.equal(
      linkResultUrl('/en/home', { authLink: 'added', strategyId: 's1' }),
      '/en/home?authLink=added&strategyId=s1'
    )
  })

  test('keeps an existing query and fragment', () => {
    assert.equal(
      linkResultUrl('/en/home?tab=2#section', { authLinkError: 'ERR_LINK_ALREADY_LINKED' }),
      '/en/home?tab=2&authLinkError=ERR_LINK_ALREADY_LINKED#section'
    )
  })

  test('replaces a stale result left over from an earlier attempt', () => {
    assert.equal(
      linkResultUrl('/p?authLinkError=ERR_LINK_ALREADY_LINKED&strategyId=old', {
        authLink: 'added',
        strategyId: 'new'
      }),
      '/p?authLink=added&strategyId=new'
    )
  })

  test('keeps an absolute target absolute', () => {
    assert.equal(
      linkResultUrl('https://wiki.example.com/p', { authLink: 'added', strategyId: 's1' }),
      'https://wiki.example.com/p?authLink=added&strategyId=s1'
    )
  })
})

describe('/auth/:strategyId/authorize?mode=link and its callback', () => {
  const STRATEGY_ID = 'c1111111-1111-1111-1111-111111111111'
  const FORM_STRATEGY_ID = 'c2222222-2222-2222-2222-222222222222'
  const SAML_STRATEGY_ID = 'c3333333-3333-3333-3333-333333333333'
  const USER_ID = 'u1111111-1111-1111-1111-111111111111'

  let app: FastifyInstance
  let session: Record<string, any>
  let storedUser: Record<string, any> | null
  let linkCalls: any[]
  let loginCalls: any[]
  let profileCalls: any[]
  let linkError: Error | null
  let profileError: Error | null
  let wikiHandle: { restore(): void }

  function signedIn(): Record<string, any> {
    return {
      authenticated: true,
      user: { id: USER_ID, email: 'ada@example.com', name: 'Ada' },
      permissions: []
    }
  }

  function linkFlow(overrides: Record<string, any> = {}) {
    return {
      strategyId: STRATEGY_ID,
      siteId: 'site-1',
      state: 'link-state',
      nonce: 'n',
      codeVerifier: 'v',
      redirect: '/en/home',
      startedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      mode: 'link',
      linkUserId: USER_ID,
      ...overrides
    }
  }

  function callback(strategyId = STRATEGY_ID, state = 'link-state') {
    return app.inject({
      method: 'GET',
      url: `/auth/${strategyId}/callback?code=the-code&state=${state}`
    })
  }

  function locationParams(res: { headers: Record<string, any> }) {
    const location = res.headers.location as string
    return { location, params: new URL(location, 'http://x.invalid').searchParams }
  }

  before(async () => {
    await ensureTemporal()
    wikiHandle = installTestWiki({
      config: { security: { authRateLimitEnabled: false } },
      models: {
        flags: { authDebug: () => {} },
        auditLog: { record: async () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            id === STRATEGY_ID
              ? { id, module: 'github', displayName: 'GitHub', isEnabled: true }
              : id === FORM_STRATEGY_ID
                ? { id, module: 'ldap', displayName: 'LDAP', isEnabled: true }
                : id === SAML_STRATEGY_ID
                  ? { id, module: 'saml', displayName: 'SAML', isEnabled: true }
                  : null
        },
        users: {
          getById: async (id: string) => (storedUser && id === storedUser.id ? storedUser : null)
        },
        login: {
          loginWithProvider: async (args: any) => {
            loginCalls.push(args)
            return { authenticated: true, nextAction: 'redirect', redirect: '/welcome' }
          },
          linkProviderToAccount: async (args: any) => {
            linkCalls.push(args)
            if (linkError) {
              throw linkError
            }
          }
        }
      },
      sitesMappings: {},
      auth: {
        strategies: {
          [STRATEGY_ID]: {
            module: 'github',
            authorizationUrl: async () => 'https://github.example/authorize?x=1',
            profile: async (args: any) => {
              profileCalls.push(args)
              if (profileError) {
                throw profileError
              }
              return {
                id: 'gh-42',
                email: 'someone-else@example.org',
                name: 'Ada',
                idToken: 'header.payload.sig'
              }
            }
          },
          [FORM_STRATEGY_ID]: {
            module: 'ldap',
            authenticate: async () => ({})
          },
          [SAML_STRATEGY_ID]: {
            module: 'saml',
            authorizationUrl: async () => 'https://idp.example/sso',
            profile: async (args: any) => {
              profileCalls.push(args)
              return { id: 'saml-1', email: 'ada@example.com', name: 'Ada' }
            }
          }
        }
      }
    })

    app = await buildTestApp({
      routes: withFormBody,
      ajv: true,
      session: () => session
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  beforeEach(() => {
    session = {}
    storedUser = { id: USER_ID, email: 'ada@example.com', auth: { 'local-id': { password: 'x' } } }
    linkCalls = []
    loginCalls = []
    profileCalls = []
    linkError = null
    profileError = null
  })

  describe('authorize', () => {
    test('stores a link-mode flow bound to the session user and redirects to the provider', async () => {
      session = signedIn()

      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/authorize?mode=link&redirect=${encodeURIComponent('/en/home')}`
      })

      assert.equal(res.statusCode, 302)
      assert.equal(res.headers.location, 'https://github.example/authorize?x=1')
      assert.equal(session.authFlow.mode, 'link')
      assert.equal(session.authFlow.linkUserId, USER_ID)
      assert.equal(session.authFlow.redirect, '/en/home')
    })

    test('a normal login start stores login mode and no linked user', async () => {
      session = signedIn()

      const res = await app.inject({ method: 'GET', url: `/auth/${STRATEGY_ID}/authorize` })

      assert.equal(res.statusCode, 302)
      assert.equal(session.authFlow.mode, 'login')
      assert.equal(session.authFlow.linkUserId, undefined)
    })

    test('refuses a session that is not signed in', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/authorize?mode=link&redirect=${encodeURIComponent('/en/home')}`
      })

      const { location, params } = locationParams(res)
      assert.equal(res.statusCode, 302)
      assert.ok(location.startsWith('/en/home?'))
      assert.equal(params.get('authLinkError'), 'ERR_LINK_NOT_SIGNED_IN')
      assert.equal(session.authFlow, undefined)
    })

    test('refuses a form-based strategy (LDAP) as unsupported', async () => {
      session = signedIn()

      const res = await app.inject({
        method: 'GET',
        url: `/auth/${FORM_STRATEGY_ID}/authorize?mode=link`
      })

      assert.equal(res.statusCode, 302)
      assert.equal(locationParams(res).params.get('authLinkError'), 'ERR_LINK_STRATEGY_UNSUPPORTED')
      assert.equal(session.authFlow, undefined)
    })

    test('refuses an unknown strategy as unsupported rather than a 404', async () => {
      session = signedIn()

      const res = await app.inject({
        method: 'GET',
        url: '/auth/c9999999-9999-9999-9999-999999999999/authorize?mode=link'
      })

      assert.equal(res.statusCode, 302)
      assert.equal(locationParams(res).params.get('authLinkError'), 'ERR_LINK_STRATEGY_UNSUPPORTED')
    })

    test('refuses a strategy the account already has linked', async () => {
      session = signedIn()
      storedUser!.auth[STRATEGY_ID] = { id: 'gh-42', email: 'ada@example.com' }

      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/authorize?mode=link`
      })

      assert.equal(res.statusCode, 302)
      assert.equal(locationParams(res).params.get('authLinkError'), 'ERR_LINK_ALREADY_LINKED')
      assert.equal(session.authFlow, undefined)
    })

    test('refuses a link start another site initiated', async () => {
      session = signedIn()

      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/authorize?mode=link`,
        headers: { 'sec-fetch-site': 'cross-site' }
      })

      assert.equal(res.statusCode, 403)
      assert.equal(session.authFlow, undefined)
    })

    test('accepts a link start navigated to from this origin', async () => {
      session = signedIn()

      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/authorize?mode=link`,
        headers: { 'sec-fetch-site': 'same-origin' }
      })

      assert.equal(res.statusCode, 302)
      assert.equal(session.authFlow.mode, 'link')
    })

    test('a cross-site header does not affect a normal login start', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/authorize`,
        headers: { 'sec-fetch-site': 'cross-site' }
      })

      assert.equal(res.statusCode, 302)
      assert.equal(session.authFlow.mode, 'login')
    })

    test('an unfollowable redirect falls back to / for the refusal too', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/authorize?mode=link&redirect=${encodeURIComponent('//attacker.example')}`
      })

      const { location } = locationParams(res)
      assert.ok(location.startsWith('/?'), location)
    })
  })

  describe('callback', () => {
    test('connects the provider to the session user without logging anyone in', async () => {
      session = { ...signedIn(), authFlow: linkFlow() }

      const res = await callback()

      const { location, params } = locationParams(res)
      assert.equal(res.statusCode, 302)
      assert.ok(location.startsWith('/en/home?'))
      assert.equal(params.get('authLink'), 'added')
      assert.equal(params.get('strategyId'), STRATEGY_ID)
      assert.equal(linkCalls.length, 1)
      assert.equal(linkCalls[0].userId, USER_ID)
      assert.equal(linkCalls[0].strategy.id, STRATEGY_ID)
      assert.equal(linkCalls[0].profile.id, 'gh-42')
      assert.equal(linkCalls[0].siteId, 'site-1')
      assert.equal(loginCalls.length, 0)
      assert.equal(session.idpSession, undefined)
      assert.equal(session.user.id, USER_ID)
      assert.equal(session.authFlow, undefined)
    })

    test('refuses when the session is no longer the user who started the flow', async () => {
      session = {
        ...signedIn(),
        user: { id: 'someone-else', email: 'x@example.com', name: 'X' },
        authFlow: linkFlow()
      }

      const res = await callback()

      assert.equal(locationParams(res).params.get('authLinkError'), 'ERR_LINK_NOT_SIGNED_IN')
      assert.equal(profileCalls.length, 0)
      assert.equal(linkCalls.length, 0)
    })

    test('refuses when the session has signed out in the meantime', async () => {
      session = { authFlow: linkFlow() }

      const res = await callback()

      assert.equal(locationParams(res).params.get('authLinkError'), 'ERR_LINK_NOT_SIGNED_IN')
      assert.equal(profileCalls.length, 0)
    })

    for (const code of [
      'ERR_LINK_ALREADY_LINKED',
      'ERR_LINK_IDENTITY_IN_USE',
      'ERR_EMAIL_NOT_ALLOWED',
      'ERR_LINK_NOT_SIGNED_IN'
    ]) {
      test(`reports a ${code} refusal back to the redirect target`, async () => {
        session = { ...signedIn(), authFlow: linkFlow() }
        linkError = new Error(code)

        const res = await callback()

        const { location, params } = locationParams(res)
        assert.ok(location.startsWith('/en/home?'))
        assert.equal(params.get('authLinkError'), code)
        assert.equal(params.get('authLink'), null)
      })
    }

    test('a provider failure with a free-text message is reported as ERR_LOGIN_FAILED', async () => {
      session = { ...signedIn(), authFlow: linkFlow() }
      profileError = new Error('token endpoint said: invalid_grant <secret-ish detail>')

      const res = await callback()

      assert.equal(locationParams(res).params.get('authLinkError'), 'ERR_LOGIN_FAILED')
      assert.equal(linkCalls.length, 0)
    })

    test('an expired link flow reports back to the redirect target, not the login screen', async () => {
      session = {
        ...signedIn(),
        authFlow: linkFlow({
          startedAt: Temporal.Now.instant()
            .subtract({ hours: 1 })
            .toString({ smallestUnit: 'millisecond' })
        })
      }

      const res = await callback()

      const { location, params } = locationParams(res)
      assert.ok(location.startsWith('/en/home?'), location)
      assert.equal(params.get('authLinkError'), 'ERR_LOGIN_EXPIRED')
      assert.equal(linkCalls.length, 0)
    })

    test('a provider-reported error on a link flow reports back to the redirect target', async () => {
      session = { ...signedIn(), authFlow: linkFlow() }

      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/callback?state=link-state&error=access_denied`
      })

      assert.equal(locationParams(res).params.get('authLinkError'), 'ERR_LOGIN_FAILED')
      assert.equal(profileCalls.length, 0)
    })

    test('the mode is taken from the stored flow, never from the callback query', async () => {
      session = { ...signedIn(), authFlow: linkFlow({ mode: 'login', linkUserId: undefined }) }

      const res = await app.inject({
        method: 'GET',
        url: `/auth/${STRATEGY_ID}/callback?code=c&state=link-state&mode=link`
      })

      assert.equal(res.statusCode, 302)
      assert.equal(res.headers.location, '/welcome')
      assert.equal(loginCalls.length, 1)
      assert.equal(linkCalls.length, 0)
    })

    test('a flow stored without a mode is still a normal login', async () => {
      const { mode: _mode, linkUserId: _linkUserId, ...legacy } = linkFlow()
      session = { authFlow: legacy }

      const res = await callback()

      assert.equal(res.headers.location, '/welcome')
      assert.equal(loginCalls.length, 1)
      assert.equal(linkCalls.length, 0)
    })

    test('a SAML form-POST callback in link mode connects the same way', async () => {
      session = { ...signedIn(), authFlow: linkFlow({ strategyId: SAML_STRATEGY_ID }) }

      const res = await app.inject({
        method: 'POST',
        url: `/auth/${SAML_STRATEGY_ID}/callback`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ SAMLResponse: 'r', RelayState: 'link-state' }).toString()
      })

      const { params } = locationParams(res)
      assert.equal(params.get('authLink'), 'added')
      assert.equal(params.get('strategyId'), SAML_STRATEGY_ID)
      assert.equal(linkCalls.length, 1)
      assert.equal(loginCalls.length, 0)
    })
  })
})
