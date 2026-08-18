import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerPageImportSchema } from './schemas/pageImport.ts'

/**
 * Route-level test for `POST /sites/:siteId/pages/import`.
 *
 * The conversion itself (format validation, size limits, error surfacing) is `models/import.ts`'s
 * job and is covered in `models/import.test.ts`. What belongs to the route, and what this file
 * checks, is the wiring around it: that it is gated on the page-rule `write:pages` permission at the
 * declared `path` — checked in the handler, per the "No route-level permissions:" convention, since
 * `config.permissions` cannot see page rules — and that the uploaded bytes and declared format reach
 * the model unchanged.
 */

let app: FastifyInstance
let checkAccess: ReturnType<typeof mock.fn>
let convertToMarkdown: ReturnType<typeof mock.fn>

before(async () => {
  checkAccess = mock.fn(() => true)
  convertToMarkdown = mock.fn(async () => '# Converted\n')

  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        actorForRequest: () => ({ id: null, permissions: [] }),
        checkAccess
      },
      pageImport: {
        convertToMarkdown
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  // -> Stands in for the real `@fastify/session` plugin, which this standalone app never registers:
  //    every request is an authenticated user unless it opts out with `x-test-anon`, so each test
  //    controls authorization through `checkAccess` rather than session plumbing.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.headers['x-test-anon'] !== 'true') {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    }
    done()
  })
  await registerApprovalSchema(app)
  await registerPageSchema(app)
  await registerPageImportSchema(app)
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  checkAccess.mock.resetCalls()
  checkAccess.mock.mockImplementation(() => true)
  convertToMarkdown.mock.resetCalls()
  convertToMarkdown.mock.mockImplementation(async () => '# Converted\n')
})

function importUrl(query: Record<string, string> = {}) {
  const params = new URLSearchParams({ format: 'mediawiki', path: 'docs/new-page', ...query })
  return `/sites/11111111-1111-1111-1111-111111111111/pages/import?${params.toString()}`
}

test('an anonymous request is refused before the model is asked to do anything', async () => {
  const res = await app.inject({
    method: 'POST',
    url: importUrl(),
    headers: { 'content-type': 'application/octet-stream', 'x-test-anon': 'true' },
    payload: Buffer.from('= Hi =')
  })
  assert.equal(res.statusCode, 401)
  assert.equal(convertToMarkdown.mock.callCount(), 0)
})

test('refuses a caller without write:pages on the declared path', async () => {
  checkAccess.mock.mockImplementation(() => false)

  const res = await app.inject({
    method: 'POST',
    url: importUrl(),
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('= Hi =')
  })
  assert.equal(res.statusCode, 403)
  assert.equal(convertToMarkdown.mock.callCount(), 0)
  // -> Checked against the declared `path`, the same permission CREATE PAGE checks
  const [, permission, page] = checkAccess.mock.calls[0].arguments as [
    unknown,
    string,
    { path: string }
  ]
  assert.equal(permission, 'write:pages')
  assert.equal(page.path, 'docs/new-page')
})

test('rejects an empty body without asking the model to convert nothing', async () => {
  const res = await app.inject({
    method: 'POST',
    url: importUrl(),
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(0)
  })
  assert.equal(res.statusCode, 400)
  assert.equal(convertToMarkdown.mock.callCount(), 0)
})

test('passes the uploaded bytes and declared format through to the model, unchanged', async () => {
  const body = Buffer.from('== Hello ==\n\nSome content.')
  const res = await app.inject({
    method: 'POST',
    url: importUrl({ format: 'mediawiki' }),
    headers: { 'content-type': 'application/octet-stream' },
    payload: body
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    ok: true,
    message: 'File converted successfully.',
    markdown: '# Converted\n'
  })
  assert.equal(convertToMarkdown.mock.callCount(), 1)
  const call = convertToMarkdown.mock.calls[0].arguments[0] as { format: string; data: Buffer }
  assert.equal(call.format, 'mediawiki')
  assert.ok(Buffer.isBuffer(call.data))
  assert.equal(call.data.toString(), body.toString())
})

test('rejects a format the schema does not know about', async () => {
  const res = await app.inject({
    method: 'POST',
    url: importUrl({ format: 'wordperfect' }),
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('nope')
  })
  assert.equal(res.statusCode, 400)
  assert.equal(convertToMarkdown.mock.callCount(), 0)
})
