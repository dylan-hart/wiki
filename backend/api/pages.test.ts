import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifySwagger from '@fastify/swagger'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * Task 602 regression coverage for `pages.ts`, the file this task's TDD change actually lands in:
 *
 * 1. `relations` and `toc` used to be `{ type: 'object', additionalProperties: true }` — accurate to
 *    nothing in particular. Both have exactly one producer (`PageRelationDialog.vue` for relations,
 *    `rendering.ts`'s `anchorHeadings`/`nestHeadings` for toc) with a fixed shape, so they are now
 *    `PageRelation#` / `PageTocNode#`. The first block below proves the tightened schema is not just
 *    documentation: fast-json-stringify silently drops a field the schema doesn't declare, so a
 *    response carrying one is proof the schema is actually narrower than before.
 * 2. `GET /sites/:siteId/pages/:pageIdOrHash` can reply 403 and 404 (`mayOnPage` / `getPage` returning
 *    null) but declared neither. The second block proves both are now declared AND that what the
 *    handler actually sends on those paths validates against the declared `ApiError` schema.
 */

const samplePage = {
  id: '11111111-1111-1111-1111-111111111111',
  path: 'foo',
  hash: 'abc123',
  alias: null,
  title: 'Foo',
  description: null,
  icon: null,
  locale: 'en',
  editor: 'markdown',
  contentType: 'text',
  publishState: 'published',
  publishStartDate: null,
  publishEndDate: null,
  isBrowsable: true,
  isSearchable: true,
  isLocked: false,
  relations: [
    {
      id: 'r1',
      position: 'left',
      label: 'Next',
      icon: 'la:arrow-left',
      target: '/bar',
      // -> Not part of `PageRelation`'s declared properties: proves the schema is enforced, not
      //    merely descriptive, since it must NOT survive serialization.
      bogusField: 'should be stripped'
    }
  ],
  tags: [],
  toc: [
    {
      key: 'h-intro',
      label: 'Intro',
      level: 1,
      children: []
    }
  ],
  render: '<p>hi</p>',
  allowComments: true,
  allowContributions: true,
  allowRatings: true,
  showSidebar: true,
  showTags: true,
  showToc: true,
  tocDepth: { min: 1, max: 2 },
  scriptJsLoad: '',
  scriptJsUnload: '',
  scriptCss: '',
  navigationId: null,
  navigationMode: 'default',
  authorId: '22222222-2222-2222-2222-222222222222',
  authorName: 'Alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z'
}

let app: FastifyInstance
let mayOnPageResult = true
let getPageResult: any = samplePage

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: {
        getPage: async () => getPageResult
      },
      groups: {
        actorForRequest: () => ({ groupIds: [], permissions: [] }),
        checkAccess: () => mayOnPageResult
      },
      approvals: {
        pageViewerState: async () => ({
          canSuggestEdits: false,
          hasOpenSuggestion: false,
          canReview: false,
          pendingSubmissions: []
        })
      },
      pageWatching: {
        isWatching: async () => false
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  await app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: { openapi: '3.1.0', info: { title: 'test', version: '0.0.0' } }
  })
  // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()` etc. is a
  //    thrown `@fastify/sensible` error, and it is THIS handler — not fastify's default — that shapes
  //    it into the `{ ok, error, statusCode, message }` the `ApiError` schema below expects.
  app.setErrorHandler((error: any, req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  await registerErrorSchema(app)
  await registerApprovalSchema(app)
  await registerPageSchema(app)
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

/** Follows a `$ref` (however `@fastify/swagger` named the component) to the schema it points at. */
function resolveRef(doc: any, schema: any): any {
  if (!schema?.$ref) return schema
  const name = schema.$ref.replace('#/components/schemas/', '')
  return doc.components.schemas[name]
}

test('Page relations and toc are no longer bare additionalProperties blobs', () => {
  const doc: any = app.swagger()
  const pageSchema = resolveRef(
    doc,
    doc.paths['/sites/{siteId}/pages/{pageIdOrHash}'].get.responses['200'].content[
      'application/json'
    ].schema
  )

  const relation = resolveRef(doc, pageSchema.properties.relations.items)
  assert.deepEqual(Object.keys(relation.properties).sort(), [
    'caption',
    'icon',
    'id',
    'label',
    'position',
    'target'
  ])
  assert.notEqual(relation.additionalProperties, true)

  const tocNode = resolveRef(doc, pageSchema.properties.toc.items)
  assert.deepEqual(Object.keys(tocNode.properties).sort(), ['children', 'key', 'label', 'level'])
  assert.notEqual(tocNode.additionalProperties, true)
})

test('GET single page declares its 403 and 404 responses', () => {
  const doc: any = app.swagger()
  const responses = doc.paths['/sites/{siteId}/pages/{pageIdOrHash}'].get.responses
  assert.ok(responses['403'], '403 must be declared: mayOnPage can refuse')
  assert.ok(responses['404'], '404 must be declared: getPage can return null')
})

test('a bogus field on a relation is stripped by the tightened schema', async () => {
  mayOnPageResult = true
  getPageResult = samplePage
  const res = await app.inject({
    method: 'GET',
    url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.relations[0].bogusField, undefined)
  assert.equal(body.relations[0].id, 'r1')
  assert.deepEqual(body.toc[0], { key: 'h-intro', label: 'Intro', level: 1, children: [] })
})

test('GET single page: 404 when the page does not exist, matching ApiError', async () => {
  getPageResult = null
  const res = await app.inject({
    method: 'GET',
    url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
  })
  assert.equal(res.statusCode, 404)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(typeof body.message, 'string')
})

test('GET single page: 403 when mayOnPage refuses', async () => {
  getPageResult = samplePage
  mayOnPageResult = false
  const res = await app.inject({
    method: 'GET',
    url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
  })
  assert.equal(res.statusCode, 403)
  const body = res.json()
  assert.equal(body.ok, false)
  mayOnPageResult = true
})
