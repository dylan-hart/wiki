import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildErrorLogContext } from './requestLogContext.ts'

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
