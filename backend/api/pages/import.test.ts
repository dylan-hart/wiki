import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { MAX_IMPORT_BATCH_BYTES, MAX_IMPORT_SIZE } from '../../models/import.ts'
import { CustomError } from '../../helpers/common.ts'

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
describe('POST /sites/:siteId/pages/import', () => {
  let app: FastifyInstance
  let checkAccess: ReturnType<typeof mock.fn>
  let convertToMarkdown: ReturnType<typeof mock.fn>

  before(async () => {
    checkAccess = mock.fn(() => true)
    convertToMarkdown = mock.fn(async () => ({ markdown: '# Converted\n' }))

    const wiki = {
      // -> `defaultLocale()` reads `WIKI.sites[siteId]?.config?.locales?.primary`, falling back to
      //    'en' -- an empty `sites` map is enough for that fallback to be exercised without throwing
      //    on an undefined `WIKI.sites`.
      sites: {},
      models: {
        groups: {
          actorForRequest: () => ({ id: null, permissions: [] }),
          checkAccess,
          groupIdsForRequest: () => []
        },
        pageImport: {
          convertToMarkdown
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: (req: any) =>
        req.headers['x-test-anon'] === 'true'
          ? undefined
          : { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    checkAccess.mock.resetCalls()
    checkAccess.mock.mockImplementation(() => true)
    convertToMarkdown.mock.resetCalls()
    convertToMarkdown.mock.mockImplementation(async () => ({ markdown: '# Converted\n' }))
  })

  function importUrl(query: Record<string, string> = {}) {
    const params = new URLSearchParams({
      fileName: 'notes.mediawiki',
      path: 'docs/new-page',
      ...query
    })
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

  test("detects the format from fileName's extension when no format is given (OpenProject #1209)", async () => {
    const body = Buffer.from('Some RST content')
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ fileName: 'design.rst' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.equal(convertToMarkdown.mock.callCount(), 1)
    assert.equal((convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format, 'rst')
  })

  test('an explicit format overrides what would otherwise be detected from fileName', async () => {
    const body = Buffer.from('== Hello ==')
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ fileName: 'notes.rst', format: 'mediawiki' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'mediawiki'
    )
  })

  test('answers 400 without asking the model when fileName has no recognized extension and no format is given', async () => {
    const res = await app.inject({
      method: 'POST',
      url: importUrl({ fileName: 'README' }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope')
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /Could not detect an import format/)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
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

  test("accepts format=markdown and passes the model's parsed title/description/tags through", async () => {
    convertToMarkdown.mock.mockImplementation(async () => ({
      markdown: '# Body\n',
      title: 'From Front Matter',
      description: 'A summary',
      tags: ['alpha', 'beta']
    }))

    const res = await app.inject({
      method: 'POST',
      url: importUrl({ format: 'markdown' }),
      headers: { 'content-type': 'text/markdown' },
      payload: Buffer.from('---\ntitle: From Front Matter\n---\n\n# Body\n')
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      ok: true,
      message: 'File converted successfully.',
      markdown: '# Body\n',
      title: 'From Front Matter',
      description: 'A summary',
      tags: ['alpha', 'beta']
    })
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'markdown'
    )
  })
})

/**
 * Builds a `multipart/form-data` body for `app.inject()`, using the platform's own `Response` to do
 * the encoding (boundary, per-part headers) rather than hand-rolling it — the same bytes a browser's
 * `fetch(..., { body: formData })` would send.
 */
async function buildMultipartPayload(
  files: {
    fieldName?: string
    fileName: string
    content: string
    type?: string
    /** Sent as this file's own `formats` field (OpenProject #1209) when given, overriding autodetection. */
    formatOverride?: string
  }[]
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData()
  for (const file of files) {
    form.append(
      file.fieldName ?? 'files',
      new Blob([file.content], { type: file.type ?? 'text/plain' }),
      file.fileName
    )
    // -> Interleaved right after its own file, same order the frontend sends them in — the route
    //    pairs a `formats` field with whichever upload it most recently pushed.
    if (file.fieldName === undefined || file.fieldName === 'files') {
      form.append('formats', file.formatOverride ?? '')
    }
  }
  const res = new Response(form)
  const payload = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type')!
  return { payload, contentType }
}

/**
 * Route-level test for `POST /sites/:siteId/pages/import/batch` (OpenProject #849).
 *
 * Same division of labor as the single-file import route above: conversion itself is
 * `models/import.ts`'s job, already covered by `models/import.test.ts`. What this suite checks is
 * the route's own wiring — the `write:pages` permission gate, that every uploaded file reaches the
 * model, and that one file failing does not stop the rest of the batch from converting.
 */
describe('POST /sites/:siteId/pages/import/batch', () => {
  let app: FastifyInstance
  let checkAccess: ReturnType<typeof mock.fn>
  let convertToMarkdown: ReturnType<typeof mock.fn>

  before(async () => {
    checkAccess = mock.fn(() => true)
    convertToMarkdown = mock.fn(async ({ data }: { data: Buffer }) => ({
      markdown: `# ${data.toString()}\n`
    }))

    const wiki = {
      sites: {},
      models: {
        groups: {
          actorForRequest: () => ({ id: null, permissions: [] }),
          checkAccess,
          groupIdsForRequest: () => []
        },
        pageImport: {
          convertToMarkdown
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: (req: any) =>
        req.headers['x-test-anon'] === 'true'
          ? undefined
          : { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    checkAccess.mock.resetCalls()
    checkAccess.mock.mockImplementation(() => true)
    convertToMarkdown.mock.resetCalls()
    convertToMarkdown.mock.mockImplementation(async ({ data }: { data: Buffer }) => ({
      markdown: `# ${data.toString()}\n`
    }))
  })

  function batchUrl(query: Record<string, string> = {}) {
    const params = new URLSearchParams({ path: 'docs/imported', ...query })
    return `/sites/11111111-1111-1111-1111-111111111111/pages/import/batch?${params.toString()}`
  }

  test('an anonymous request is refused before any file is read', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'a.mediawiki', content: '= A =' }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType, 'x-test-anon': 'true' },
      payload
    })
    assert.equal(res.statusCode, 401)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
  })

  test('refuses a caller without write:pages on the declared path', async () => {
    checkAccess.mock.mockImplementation(() => false)
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'a.mediawiki', content: '= A =' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 403)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
    const [, permission, page] = checkAccess.mock.calls[0].arguments as [
      unknown,
      string,
      { path: string }
    ]
    assert.equal(permission, 'write:pages')
    assert.equal(page.path, 'docs/imported')
  })

  test('rejects a request with no files without asking the model to convert anything', async () => {
    const { payload, contentType } = await buildMultipartPayload([])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 400)
    assert.equal(convertToMarkdown.mock.callCount(), 0)
  })

  test("autodetects each file's format from its own extension (OpenProject #1209)", async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'first.mediawiki', content: 'First' },
      { fileName: 'second.rst', content: 'Second' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.results, [
      { fileName: 'first.mediawiki', ok: true, markdown: '# First\n' },
      { fileName: 'second.rst', ok: true, markdown: '# Second\n' }
    ])
    assert.equal(convertToMarkdown.mock.callCount(), 2)
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'mediawiki'
    )
    assert.equal((convertToMarkdown.mock.calls[1].arguments[0] as { format: string }).format, 'rst')
  })

  test("a per-file 'formats' override wins over that file's own detected extension", async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'first.mediawiki', content: 'First', formatOverride: 'textile' },
      { fileName: 'second.rst', content: 'Second' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    assert.equal(
      (convertToMarkdown.mock.calls[0].arguments[0] as { format: string }).format,
      'textile'
    )
    assert.equal((convertToMarkdown.mock.calls[1].arguments[0] as { format: string }).format, 'rst')
  })

  test('a file with an unrecognized extension fails only its own entry, without asking the model', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'README', content: 'no extension' },
      { fileName: 'second.rst', content: 'Second' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'README')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /Could not detect an import format/)
    assert.deepEqual(body.results[1], {
      fileName: 'second.rst',
      ok: true,
      markdown: '# Second\n'
    })
    assert.equal(convertToMarkdown.mock.callCount(), 1)
  })

  test('one file failing does not stop the rest of the batch from converting', async () => {
    convertToMarkdown.mock.mockImplementation(async ({ data }: { data: Buffer }) => {
      if (data.toString() === 'bad') {
        throw new CustomError(
          'importNoContent',
          'Pandoc converted this file but produced no usable content.',
          400
        )
      }
      return { markdown: `# ${data.toString()}\n` }
    })
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'good.mediawiki', content: 'good' },
      { fileName: 'bad.mediawiki', content: 'bad' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.results.length, 2)
    assert.deepEqual(body.results[0], {
      fileName: 'good.mediawiki',
      ok: true,
      markdown: '# good\n'
    })
    assert.equal(body.results[1].fileName, 'bad.mediawiki')
    assert.equal(body.results[1].ok, false)
    assert.match(body.results[1].message, /no usable content/)
  })

  /**
   * Regression test (OpenProject #849 fix): `@fastify/multipart`'s default `throwFileSizeLimit: true`
   * makes an oversized file's `toBuffer()` reject as the route's own comment describes, but it ALSO
   * latches that rejection and replays it out of `req.files()`'s iterator on the very next
   * `for await` step — even one that only advances past files already handled locally — turning "one
   * bad file fails independently" into a 413 for the whole batch regardless of how many files after
   * it converted fine. This sends a real oversized file (`MAX_IMPORT_SIZE`-plus-one, so the size
   * limit itself trips rather than being mocked) ahead of a good one and asserts the batch still
   * answers 200 with one failed entry and one successful one, not a request-level failure.
   */
  test('an oversized file fails only its own entry, not the whole batch', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'toobig.mediawiki', content: 'x'.repeat(MAX_IMPORT_SIZE + 1) },
      { fileName: 'fine.mediawiki', content: '= Fine =' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.results.length, 2)
    assert.equal(body.results[0].fileName, 'toobig.mediawiki')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /larger than the import limit/)
    assert.deepEqual(body.results[1], {
      fileName: 'fine.mediawiki',
      ok: true,
      markdown: '# = Fine =\n'
    })
  })

  test("autodetects format: markdown from .md and passes each result's parsed title/description/tags through", async () => {
    convertToMarkdown.mock.mockImplementation(async ({ data }: { data: Buffer }) => ({
      markdown: '# Body\n',
      title: `Title for ${data.toString()}`,
      tags: ['imported']
    }))
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'one.md', content: 'one' },
      { fileName: 'two.md', content: 'two' }
    ])

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(body.results, [
      {
        fileName: 'one.md',
        ok: true,
        markdown: '# Body\n',
        title: 'Title for one',
        tags: ['imported']
      },
      {
        fileName: 'two.md',
        ok: true,
        markdown: '# Body\n',
        title: 'Title for two',
        tags: ['imported']
      }
    ])
    for (const call of convertToMarkdown.mock.calls) {
      assert.equal((call.arguments[0] as { format: string }).format, 'markdown')
    }
  })

  /**
   * OpenProject #2204: the aggregate ceiling that backstops the whole batch, distinct from the
   * per-file `MAX_IMPORT_SIZE` regression test above — five files, each right at (not over) the
   * per-file limit so none is individually truncated, whose sum is still well past
   * `MAX_IMPORT_BATCH_BYTES` (four times a single file's own limit). The whole request must be
   * refused rather than converting the files that fit before the ceiling was crossed.
   */
  test('a batch exceeding the aggregate byte ceiling is refused, not partially converted', async () => {
    const perFile = 'x'.repeat(MAX_IMPORT_SIZE)
    const { payload, contentType } = await buildMultipartPayload(
      Array.from({ length: 5 }, (_, i) => ({
        fileName: `file-${i}.mediawiki`,
        content: perFile
      }))
    )

    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })

    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.match(body.message, /aggregate limit/)
    assert.match(body.message, new RegExp(`${Math.round(MAX_IMPORT_BATCH_BYTES / 1024 / 1024)} MB`))
    assert.equal(convertToMarkdown.mock.callCount(), 0, 'no file should be converted once refused')
  })
})
