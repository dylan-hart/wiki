import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildErrorLogContext, buildRequestLogContext } from './requestLogContext.ts'

describe('buildRequestLogContext', () => {
  test('is reqId plus the actor and site the request ran under, and nothing else', () => {
    const context = buildRequestLogContext({
      id: 'req-1',
      session: { authenticated: true, user: { id: 'user-1' } }
    })

    assert.deepEqual(context, { reqId: 'req-1', siteId: undefined, userId: 'user-1' })
  })

  test('prefers a :siteId route param, which is how a site-scoped API route names its site', () => {
    const context = buildRequestLogContext({
      id: 'req-2',
      params: { siteId: 'site-from-param' },
      site: { id: 'site-from-hostname' }
    })

    assert.equal(context.siteId, 'site-from-param')
  })

  test('falls back to the site the routing hook resolved, which is what a page request has', () => {
    const context = buildRequestLogContext({
      id: 'req-3',
      site: { id: 'site-from-hostname' }
    })

    assert.equal(context.siteId, 'site-from-hostname')
  })

  test('leaves siteId undefined when neither exists, rather than guessing at one', () => {
    assert.equal(buildRequestLogContext({ id: 'req-4' }).siteId, undefined)
    assert.equal(buildRequestLogContext({ id: 'req-5', site: null }).siteId, undefined)
    assert.equal(
      buildRequestLogContext({ id: 'req-6', params: { somethingElse: 'x' } }).siteId,
      undefined
    )
  })

  test('never leaks a stale user id off an unauthenticated session', () => {
    const context = buildRequestLogContext({
      id: 'req-7',
      session: { authenticated: false, user: { id: 'user-1' } }
    })

    assert.equal(context.userId, undefined)
  })
})

describe('buildErrorLogContext', () => {
  test('carries reqId/method/url for an anonymous, non-site-scoped request', () => {
    const context = buildErrorLogContext({
      id: 'req-1',
      method: 'GET',
      url: '/_api/pages/1',
      session: { authenticated: false }
    })

    assert.deepEqual(context, {
      reqId: 'req-1',
      method: 'GET',
      url: '/_api/pages/1',
      siteId: undefined,
      userId: undefined
    })
  })

  test('reads siteId off a :siteId route param when the failing route is site-scoped', () => {
    const context = buildErrorLogContext({
      id: 'req-2',
      method: 'PATCH',
      url: '/_api/sites/site-1/general',
      params: { siteId: 'site-1' },
      session: { authenticated: false }
    })

    assert.equal(context.siteId, 'site-1')
  })

  test('leaves siteId undefined when the route has no :siteId param', () => {
    const context = buildErrorLogContext({
      id: 'req-3',
      method: 'GET',
      url: '/_api/system',
      params: { somethingElse: 'x' },
      session: { authenticated: false }
    })

    assert.equal(context.siteId, undefined)
  })

  test('carries userId for an authenticated session, undefined for an anonymous one', () => {
    const authenticated = buildErrorLogContext({
      id: 'req-4',
      method: 'POST',
      url: '/_api/pages',
      session: { authenticated: true, user: { id: 'user-1' } }
    })
    assert.equal(authenticated.userId, 'user-1')

    const anonymous = buildErrorLogContext({
      id: 'req-5',
      method: 'POST',
      url: '/_api/pages',
      session: { authenticated: false, user: { id: 'user-1' } }
    })
    assert.equal(
      anonymous.userId,
      undefined,
      'an unauthenticated session must not leak a stale user id'
    )
  })

  test('shares its actor/site derivation with the access line, so the two agree on one request', () => {
    const req = {
      id: 'req-7',
      method: 'GET',
      url: '/some/page',
      site: { id: 'site-2' },
      session: { authenticated: true, user: { id: 'user-2' } }
    }

    const { reqId, siteId, userId } = buildRequestLogContext(req)
    const context = buildErrorLogContext(req)

    assert.equal(context.reqId, reqId)
    assert.equal(context.siteId, siteId)
    assert.equal(context.userId, userId)
    assert.deepEqual(context, {
      reqId: 'req-7',
      method: 'GET',
      url: '/some/page',
      siteId: 'site-2',
      userId: 'user-2'
    })
  })

  test('tolerates a request with no session at all (guest, session plugin not yet run)', () => {
    const context = buildErrorLogContext({
      id: 'req-6',
      method: 'GET',
      url: '/_api/system'
    })

    assert.equal(context.userId, undefined)
    assert.equal(context.siteId, undefined)
  })
})
