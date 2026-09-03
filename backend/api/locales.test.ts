import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import localesRoutes from './locales.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * `buildTestApp`'s `session: 'header'` + `permissions: true` install the real
 * `config.permissions` preHandler over a header-seeded session (see `groups.test.ts` for the same
 * pattern) — needed here only because `POST /sideload` is this file's first route that actually
 * declares route-level permissions; the two `GET` routes above are `publicAccess: true` and never
 * exercised this path.
 */
function headersFor(permissions: string[]) {
  return {
    'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] })
  }
}

/**
 * Regression test for the two `response` schema gaps on `GET /` and `GET /:code/strings`: with no
 * `response` block, the generated OpenAPI document has no concrete schema for the 200 response
 * (Swagger UI then renders the empty-body fallback instead of an example). The primary assertions
 * below inspect the generated document itself, since that is literally what the task is about; the
 * injection tests underneath additionally guard against a schema that is present but wrong — narrower
 * than the real shape, which fast-json-stringify would silently enforce by dropping fields rather than
 * throwing.
 */

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

// -> Mutable so a test can simulate a locale sideload changing what `getStrings('en')` returns
//    without re-registering the whole app.
let currentEnStrings: Record<string, string> = sampleStrings

before(async () => {
  app = await buildTestApp({
    routes: localesRoutes,
    swagger: true,
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

test('GET / documents a concrete 200 response schema', () => {
  const doc: any = app.swagger()
  const responseSchema = doc.paths['/'].get.responses['200'].content['application/json'].schema
  assert.equal(responseSchema.type, 'array')
  assert.equal(responseSchema.items.type, 'object')
  assert.deepEqual(Object.keys(responseSchema.items.properties).sort(), [
    'code',
    'completeness',
    'createdAt',
    'isRTL',
    'language',
    'name',
    'nativeName',
    'updatedAt'
  ])
})

test('GET /:code/strings documents a concrete 200 response schema', () => {
  const doc: any = app.swagger()
  const responseSchema =
    doc.paths['/{code}/strings'].get.responses['200'].content['application/json'].schema
  // -> Either shape the handler can actually return: the strings map, or `[]` for an unknown code.
  const alternatives = responseSchema.oneOf ?? responseSchema.anyOf
  assert.ok(Array.isArray(alternatives) && alternatives.length === 2)
  assert.ok(alternatives.some((s: any) => s.type === 'object'))
  assert.ok(alternatives.some((s: any) => s.type === 'array'))
})

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

/**
 * ETag/304 (OpenProject #1920): the ~190 KB translation map should not be re-sent on every cold
 * page load — a browser holding a matching `ETag` from a prior response should get an empty `304`
 * instead. `#1915` (caching `getStrings()` in `WIKI.cache`) is separate, out-of-scope work; these
 * tests only cover the route's header/revalidation behavior against whatever the model returns.
 */
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
 * `POST /sideload` (OpenProject #820): a `manage:system`-only trigger for
 * `WIKI.models.locales.sideloadFromDataPath`, letting an admin rescan `<dataPath>/locales/` for a
 * dropped-in locale pack against a running instance without a restart.
 */
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
