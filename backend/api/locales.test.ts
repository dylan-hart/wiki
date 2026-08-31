import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifySwagger from '@fastify/swagger'
import localesRoutes from './locales.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * Minimal stand-ins for `index.ts`'s real session decoration + `config.permissions` preHandler hook
 * (see `groups.test.ts` for the same pattern) — needed here only because `POST /sideload` is this
 * file's first route that actually declares route-level permissions; the two `GET` routes above are
 * `publicAccess: true` and never exercised this path.
 */
function testSessionOnRequest(
  req: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void
) {
  const header = req.headers['x-test-session']
  if (header) {
    ;(req as any).session = JSON.parse(header as string)
  }
  done()
}

function permissionPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
) {
  const routePermissions = req.routeOptions.config?.permissions
  if (routePermissions && routePermissions.length > 0) {
    const session = (req as any).session
    const permissions = session?.authenticated ? session.permissions : null
    if (!permissions || permissions.length < 1) {
      return reply.unauthorized()
    }
    if (!permissions.includes('manage:system')) {
      const isAllowed = routePermissions.some((perms: any) => {
        if (Array.isArray(perms)) {
          return perms.every((perm: string) => permissions.some((p: string) => p === perm))
        }
        return permissions.some((p: string) => p === perms)
      })
      if (!isAllowed) {
        return reply.forbidden()
      }
    }
  }
  done()
}

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

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      locales: {
        getLocales: async () => [sampleLocale],
        getStrings: async (code: string) => (code === 'en' ? sampleStrings : []),
        sideloadFromDataPath: async () => sideloadResult
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  app.setErrorHandler((error: any, _req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  await registerErrorSchema(app)
  await app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: { openapi: '3.1.0', info: { title: 'test', version: '0.0.0' } }
  })
  app.addHook('onRequest', testSessionOnRequest)
  app.addHook('preHandler', permissionPreHandler)
  await app.register(localesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

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
 * `GET /:code/strings` ETag (OpenProject #1839): derived from the matching locale row's `updatedAt`
 * (`sampleLocale.updatedAt` -> `2026-01-02T00:00:00.000Z`), the same `"<key>-<epochMs>"` shape
 * `controllers/files.ts`'s existing asset ETag already uses.
 */
const sampleLocaleEtag = `"en-${sampleLocale.updatedAt.getTime()}"`

test('GET /:code/strings sets an ETag derived from the locale row updatedAt', async () => {
  const res = await app.inject({ method: 'GET', url: '/en/strings' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.etag, sampleLocaleEtag)
  assert.deepEqual(res.json(), sampleStrings)
})

test('GET /:code/strings returns 304 with no body for a matching If-None-Match', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/en/strings',
    headers: { 'if-none-match': sampleLocaleEtag }
  })
  assert.equal(res.statusCode, 304)
  assert.equal(res.body, '')
})

test('GET /:code/strings returns the full payload for a stale If-None-Match', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/en/strings',
    headers: { 'if-none-match': '"en-0"' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.etag, sampleLocaleEtag)
  assert.deepEqual(res.json(), sampleStrings)
})

test('GET /:code/strings sets no ETag for an unknown locale', async () => {
  const res = await app.inject({ method: 'GET', url: '/xx/strings' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers.etag, undefined)
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
