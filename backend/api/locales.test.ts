import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import localesRoutes from './locales.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/** Only `POST /sideload` needs a session: the two `GET` routes are `publicAccess: true`. */
function headersFor(permissions: string[]) {
  return {
    'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] })
  }
}

const sampleLocale = {
  code: 'en',
  isRTL: false,
  language: 'en',
  name: 'English',
  nativeName: 'English',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  completeness: 87
}

const sampleStrings = {
  'admin.adminArea': 'Administration Area',
  'common.actions.save': 'Save'
}

let app: FastifyInstance

const sideloadResult = { loaded: ['tlh'], skipped: [{ code: 'broken', error: 'invalid JSON' }] }

// -> Mutable so a test can change what `getStrings('en')` returns without rebuilding the app.
let currentEnStrings: Record<string, string> = sampleStrings

before(async () => {
  app = await buildTestApp({
    routes: localesRoutes,
    session: 'header',
    permissions: true,
    wiki: {
      models: {
        locales: {
          getLocales: async () => [sampleLocale],
          getStrings: async (code: string) => (code === 'en' ? currentEnStrings : []),
          sideloadFromDataPath: async () => sideloadResult
        }
      }
    }
  })
})

after(() => closeTestApp(app))

test('GET / serializes every field of a locale row', async () => {
  const res = await app.inject({ method: 'GET', url: '/' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.length, 1)
  assert.deepEqual(body[0], {
    code: 'en',
    isRTL: false,
    language: 'en',
    name: 'English',
    nativeName: 'English',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    completeness: 87
  })
})

test('GET /:code/strings serializes the full key/value map for a known locale', async () => {
  const res = await app.inject({ method: 'GET', url: '/en/strings' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), sampleStrings)
})

test('GET /:code/strings serializes an empty array for an unknown locale', async () => {
  const res = await app.inject({ method: 'GET', url: '/xx/strings' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [])
})

test('GET /:code/strings carries a quoted ETag and a revalidation Cache-Control', async () => {
  const res = await app.inject({ method: 'GET', url: '/en/strings' })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers.etag as string, /^".+"$/)
  assert.equal(res.headers['cache-control'], 'public, no-cache')
})

test('GET /:code/strings returns an empty-bodied 304 when if-none-match matches the current ETag', async () => {
  const first = await app.inject({ method: 'GET', url: '/en/strings' })
  const etag = first.headers.etag as string

  const second = await app.inject({
    method: 'GET',
    url: '/en/strings',
    headers: { 'if-none-match': etag }
  })
  assert.equal(second.statusCode, 304)
  assert.equal(second.body, '')
  assert.equal(second.headers.etag, etag)
})

test('GET /:code/strings still returns 200 with the full body when if-none-match is stale', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/en/strings',
    headers: { 'if-none-match': '"not-the-real-etag"' }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), sampleStrings)
})

test('GET /:code/strings produces a well-formed, matchable ETag for the unknown-locale [] shape too', async () => {
  const first = await app.inject({ method: 'GET', url: '/xx/strings' })
  assert.match(first.headers.etag as string, /^".+"$/)

  const second = await app.inject({
    method: 'GET',
    url: '/xx/strings',
    headers: { 'if-none-match': first.headers.etag as string }
  })
  assert.equal(second.statusCode, 304)
})

test('GET /:code/strings returns a 200 with a different ETag after the underlying strings change (e.g. a sideload)', async () => {
  const before = await app.inject({ method: 'GET', url: '/en/strings' })
  const beforeEtag = before.headers.etag as string

  currentEnStrings = { ...sampleStrings, 'common.actions.cancel': 'Cancel' }
  try {
    const after = await app.inject({
      method: 'GET',
      url: '/en/strings',
      headers: { 'if-none-match': beforeEtag }
    })
    assert.equal(after.statusCode, 200)
    assert.deepEqual(after.json(), currentEnStrings)
    assert.notEqual(after.headers.etag, beforeEtag)

    const expectedEtag = `"${crypto.createHash('sha1').update(JSON.stringify(currentEnStrings)).digest('hex')}"`
    assert.equal(after.headers.etag, expectedEtag)
  } finally {
    currentEnStrings = sampleStrings
  }
})

/**
 * A handler that answers the 304 with a bare `return` instead of `return reply` sends it twice when
 * an async `onSend` hook is pending (see `notModifiedOrPrepare()`). `app.inject()` does not surface
 * that — light-my-request's second `writeHead` does not throw — but the double send runs the
 * `onSend` chain twice, so that is the assertion. The hook defers on a real macrotask: a
 * microtask-only one can finish before Fastify's own `.then` runs, passing for the wrong reason.
 */
test('GET /:code/strings sends its 304 exactly once, behind an async onSend hook', async () => {
  let onSendCalls = 0

  // -> A plugin wrapper: an `app.addHook` after `buildTestApp` has called `ready()` is too late.
  const withAsyncOnSend = async (instance: FastifyInstance) => {
    instance.addHook('onSend', async (_req, _reply, payload) => {
      onSendCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return payload
    })
    await instance.register(localesRoutes)
  }

  const hooked = await buildTestApp({
    routes: withAsyncOnSend,
    wiki: {
      models: {
        locales: {
          getStrings: async (code: string) => (code === 'en' ? sampleStrings : [])
        }
      }
    }
  })

  try {
    const first = await hooked.inject({ method: 'GET', url: '/en/strings' })
    assert.equal(first.statusCode, 200)

    onSendCalls = 0
    const second = await hooked.inject({
      method: 'GET',
      url: '/en/strings',
      headers: { 'if-none-match': first.headers.etag as string }
    })

    assert.equal(second.statusCode, 304)
    assert.equal(second.body, '')
    assert.equal(
      onSendCalls,
      1,
      'the 304 was written twice — the handler resolved with `undefined` instead of `return reply`'
    )
  } finally {
    await closeTestApp(hooked)
  }
})

test('POST /sideload requires manage:system', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sideload',
    headers: headersFor(['manage:users'])
  })
  assert.equal(res.statusCode, 403)
})

test('POST /sideload refuses an unauthenticated request', async () => {
  const res = await app.inject({ method: 'POST', url: '/sideload' })
  assert.equal(res.statusCode, 401)
})

test('POST /sideload runs the rescan and returns what it did', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sideload',
    headers: headersFor(['manage:system'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), sideloadResult)
})
