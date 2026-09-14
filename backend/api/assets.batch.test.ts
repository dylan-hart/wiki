import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import routes from './assets.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { CustomError } from '../helpers/common.ts'

/**
 * Builds a `multipart/form-data` body for `app.inject()`, using the platform's own `Response` to do
 * the encoding (boundary, per-part headers) rather than hand-rolling it — same helper shape as
 * `api/pages/import.test.ts#buildMultipartPayload`, minus the `formats` field this route has no
 * equivalent of.
 */
async function buildMultipartPayload(
  files: { fileName: string; content: string; type?: string }[]
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData()
  for (const file of files) {
    form.append(
      'files',
      new Blob([file.content], { type: file.type ?? 'image/png' }),
      file.fileName
    )
  }
  const res = new Response(form)
  const payload = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type')!
  return { payload, contentType }
}

/**
 * Route-level test for `POST /sites/:siteId/assets/batch` (OpenProject #3211/#3231).
 *
 * `models/assets.ts#upload()` itself (conflict behavior, thumbnailing, SVG scanning, ...) is already
 * covered in `models/assets.test.ts`; the single-file route's own destination resolution (`folderId`
 * vs `parentPath`, site scoping) is covered in `assets.test.ts`. What this suite checks is the
 * batch route's own wiring: that every file reaches `upload()` with the shared destination, that a
 * denied permission or a model failure fails only its own entry rather than the whole batch, and
 * that the admin-configurable per-request file-count limit (`security.uploadMaxFilesPerBatch`) is
 * enforced by the multipart parser itself, before an over-the-limit file is ever read.
 */
describe('POST /sites/:siteId/assets/batch', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const RESOLVED_FOLDER_ID = '22222222-2222-4222-8222-222222222222'

  let app: FastifyInstance
  let getFolderCalls: any[]
  let checkAccessCalls: any[]
  let uploadCalls: any[]
  let checkAccessDeny: Set<string>
  let uploadThrows: Map<string, Error>

  before(async () => {
    getFolderCalls = []
    checkAccessCalls = []
    uploadCalls = []
    checkAccessDeny = new Set()
    uploadThrows = new Map()

    app = await buildTestApp({
      routes,
      ajv: true,
      session: 'header',
      wiki: {
        sites: {
          [SITE_ID]: { id: SITE_ID, isEnabled: true, config: { locales: { primary: 'en' } } }
        },
        config: { security: {} },
        models: {
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            checkAccess: (_actor: any, _permission: string, page: { path: string }) => {
              checkAccessCalls.push(page)
              return !checkAccessDeny.has(page.path)
            }
          },
          tree: {
            getFolder: async (opts: any) => {
              getFolderCalls.push(opts)
              return { id: RESOLVED_FOLDER_ID, folderPath: 'guides', fileName: 'setup' }
            }
          },
          assets: {
            upload: async (opts: any) => {
              uploadCalls.push(opts)
              const thrown = uploadThrows.get(opts.fileName)
              if (thrown) {
                throw thrown
              }
              return {
                id: `asset-${opts.fileName}`,
                fileName: opts.fileName,
                fileExt: opts.fileName.split('.').pop(),
                kind: 'image',
                mimeType: opts.mimeType,
                fileSize: opts.data.length,
                folderPath: 'guides/setup',
                title: opts.fileName,
                hasPreview: false,
                createdAt: new Date('2024-01-01T00:00:00Z'),
                updatedAt: new Date('2024-01-01T00:00:00Z')
              }
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    getFolderCalls = []
    checkAccessCalls = []
    uploadCalls = []
    checkAccessDeny = new Set()
    uploadThrows = new Map()
  })

  function sessionHeader() {
    return {
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: 'user-1' },
        permissions: []
      })
    }
  }

  function batchUrl(query: Record<string, string> = {}) {
    const params = new URLSearchParams({ parentPath: 'guides/setup', ...query })
    return `/sites/${SITE_ID}/assets/batch?${params.toString()}`
  }

  test('an anonymous request is refused before any file is read', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'a.png', content: 'aaa' }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 401)
    assert.equal(uploadCalls.length, 0)
  })

  test('rejects a request with no files without asking the model to upload anything', async () => {
    const { payload, contentType } = await buildMultipartPayload([])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { ...sessionHeader(), 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 400)
    assert.equal(uploadCalls.length, 0)
  })

  test('uploads every file in the batch to the one shared, resolved-once destination', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'a.png', content: 'aaa' },
      { fileName: 'b.png', content: 'bbb' }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { ...sessionHeader(), 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.results.length, 2)
    assert.deepEqual(
      body.results.map((r: any) => [r.fileName, r.ok]),
      [
        ['a.png', true],
        ['b.png', true]
      ]
    )
    assert.equal(uploadCalls.length, 2)
    assert.equal(uploadCalls[0].folderId, RESOLVED_FOLDER_ID)
    assert.equal(uploadCalls[1].folderId, RESOLVED_FOLDER_ID)
    // -> Every file shares one destination, so the folder is resolved-or-created only once for the
    //    whole batch, not once per file.
    assert.equal(getFolderCalls.length, 1)
    assert.equal(checkAccessCalls.length, 2)
    assert.equal(checkAccessCalls[0].path, 'guides/setup/a.png')
    assert.equal(checkAccessCalls[1].path, 'guides/setup/b.png')
  })

  test('a denied permission fails only that file, and never resolves the folder for a fully-denied batch', async () => {
    checkAccessDeny = new Set(['guides/setup/a.png', 'guides/setup/b.png'])
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'a.png', content: 'aaa' },
      { fileName: 'b.png', content: 'bbb' }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { ...sessionHeader(), 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /not allowed to upload/)
    assert.equal(body.results[1].ok, false)
    assert.equal(uploadCalls.length, 0)
    assert.equal(getFolderCalls.length, 0, 'no folder side effect from a fully-denied batch')
  })

  test('a denied permission on one file does not stop the rest of the batch from uploading', async () => {
    checkAccessDeny = new Set(['guides/setup/bad.png'])
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'bad.png', content: 'aaa' },
      { fileName: 'good.png', content: 'bbb' }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { ...sessionHeader(), 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'bad.png')
    assert.equal(body.results[0].ok, false)
    assert.equal(body.results[1].fileName, 'good.png')
    assert.equal(body.results[1].ok, true)
    assert.equal(uploadCalls.length, 1)
  })

  test('a model failure (e.g. a naming conflict) fails only its own entry, not the whole batch', async () => {
    uploadThrows.set(
      'taken.png',
      new CustomError('assetAlreadyExists', 'A file already exists at this path.', 409)
    )
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'taken.png', content: 'aaa' },
      { fileName: 'fine.png', content: 'bbb' }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { ...sessionHeader(), 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'taken.png')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /already exists/)
    assert.equal(body.results[1].ok, true)
  })

  /**
   * `@fastify/multipart`'s `limits` are read from `WIKI.config.security` once, at
   * plugin-registration time — exactly like `blocks.test.ts`'s own upload-size-cap test, and for the
   * same reason `assets.ts`'s route comment gives for `addContentTypeParser`'s `bodyLimit`. A
   * separate app instance is built here (reusing the same installed `WIKI` global, mutated first)
   * so each test proves the configured limit is actually wired up, rather than only asserting the
   * source line reads the config key.
   */
  describe('registration-time limits (security.uploadMaxFileSize / uploadMaxFilesPerBatch)', () => {
    /**
     * Mirrors `api/pages/import.test.ts`'s own oversized-file regression (OpenProject #849): with
     * `throwFileSizeLimit: false`, an oversized file's `toBuffer()` resolves rather than throwing,
     * and the route reads `part.file.truncated` itself -- so one oversized file fails only its own
     * entry.
     */
    test('an oversized file fails only its own entry, not the whole batch', async () => {
      WIKI.config.security.uploadMaxFileSize = 4
      const smallApp = await buildTestApp({ routes, ajv: true, session: 'header' })
      try {
        const { payload, contentType } = await buildMultipartPayload([
          { fileName: 'toobig.png', content: 'way more than four bytes' },
          { fileName: 'fine.png', content: 'ok' }
        ])
        const res = await smallApp.inject({
          method: 'POST',
          url: batchUrl(),
          headers: { ...sessionHeader(), 'content-type': contentType },
          payload
        })
        assert.equal(res.statusCode, 200)
        const body = res.json()
        assert.equal(body.results[0].fileName, 'toobig.png')
        assert.equal(body.results[0].ok, false)
        assert.match(body.results[0].message, /larger than the/)
        assert.equal(body.results[1].fileName, 'fine.png')
        assert.equal(body.results[1].ok, true)
        assert.equal(uploadCalls.length, 1)
      } finally {
        await closeTestApp(smallApp)
        WIKI.config.security.uploadMaxFileSize = undefined
      }
    })

    /**
     * The WP's own acceptance criteria: a batch exceeding the admin-configured file-count limit is
     * rejected at parse time, before the extra files are read into memory -- exercised here as a
     * whole-request 413 with nothing uploaded, rather than a partial per-file result.
     */
    test('a batch with more files than the configured per-request limit answers 413, with nothing uploaded', async () => {
      WIKI.config.security.uploadMaxFilesPerBatch = 1
      const smallApp = await buildTestApp({ routes, ajv: true, session: 'header' })
      try {
        const { payload, contentType } = await buildMultipartPayload([
          { fileName: 'a.png', content: 'aaa' },
          { fileName: 'b.png', content: 'bbb' }
        ])
        const res = await smallApp.inject({
          method: 'POST',
          url: batchUrl(),
          headers: { ...sessionHeader(), 'content-type': contentType },
          payload
        })
        assert.equal(res.statusCode, 413)
        assert.match(res.json().message, /1 file limit/)
        assert.equal(uploadCalls.length, 0)
      } finally {
        await closeTestApp(smallApp)
        WIKI.config.security.uploadMaxFilesPerBatch = undefined
      }
    })

    test('a batch at or under the configured limit still succeeds', async () => {
      WIKI.config.security.uploadMaxFilesPerBatch = 2
      const smallApp = await buildTestApp({ routes, ajv: true, session: 'header' })
      try {
        const { payload, contentType } = await buildMultipartPayload([
          { fileName: 'a.png', content: 'aaa' },
          { fileName: 'b.png', content: 'bbb' }
        ])
        const res = await smallApp.inject({
          method: 'POST',
          url: batchUrl(),
          headers: { ...sessionHeader(), 'content-type': contentType },
          payload
        })
        assert.equal(res.statusCode, 200)
        assert.equal(uploadCalls.length, 2)
      } finally {
        await closeTestApp(smallApp)
        WIKI.config.security.uploadMaxFilesPerBatch = undefined
      }
    })
  })
})
