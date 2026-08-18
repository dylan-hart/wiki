import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifySwagger from '@fastify/swagger'
import localesRoutes from './locales.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

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

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      locales: {
        getLocales: async () => [sampleLocale],
        getStrings: async (code: string) => (code === 'en' ? sampleStrings : [])
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await registerErrorSchema(app)
  await app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: { openapi: '3.1.0', info: { title: 'test', version: '0.0.0' } }
  })
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
