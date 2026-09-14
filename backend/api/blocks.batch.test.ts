import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import routes from './blocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { CustomError } from '../helpers/common.ts'

/** A well-formed `component.js` declaring the given tag, matching `blocks.test.ts`'s own fixture shape. */
function blockSource(tag: string, definedTag = `block-${tag}`): string {
  return `
export class BlockWidget extends HTMLElement {
  static definition = {
    block: '${tag}',
    name: '${tag}',
    description: 'A test widget.',
    icon: 'mdi:cube',
    props: [],
    template: ''
  }
}
customElements.define('${definedTag}', BlockWidget)
`
}

/**
 * Builds a `multipart/form-data` body for `app.inject()`, using the platform's own `Response` to do
 * the encoding — same helper shape as `api/assets.batch.test.ts` and
 * `api/pages/import.test.ts#buildMultipartPayload`.
 */
async function buildMultipartPayload(
  files: { fileName: string; content: string }[]
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData()
  for (const file of files) {
    form.append('files', new Blob([file.content], { type: 'text/javascript' }), file.fileName)
  }
  const res = new Response(form)
  const payload = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type')!
  return { payload, contentType }
}

/**
 * Route-level test for `POST /sites/:siteId/blocks/batch` (OpenProject #3211/#3231).
 *
 * `models/blocks.ts#isTagTaken()`/`createCustomBlock()` themselves are covered against a real
 * database in `models/blocks.test.ts`; the single-file route's own AST/definition/tag validation is
 * covered in `blocks.test.ts`. What this suite checks is the batch route's own wiring: that the
 * same per-file validation runs for every file, that a bad file fails only its own entry, and —
 * batch-specific — that two files in ONE request claiming the same tag cannot both win (the second
 * is refused even though `isTagTaken()` alone would not have caught it, since neither has been
 * inserted yet when the second is checked).
 *
 * `config.permissions: ['manage:sites']` is enforced by the global `preHandler` hook in `index.ts`,
 * which this plugin-only app never registers — same convention `blocks.test.ts` documents for the
 * single-file route: not this suite's job to re-prove.
 */
describe('POST /sites/:siteId/blocks/batch', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'

  let app: FastifyInstance
  let createCustomBlockCalls: { siteId: string; definition: any; code: Buffer }[]
  let isTagTakenCalls: string[]
  let isTagTakenResult: Set<string>
  let createCustomBlockThrows: Map<string, Error>

  before(async () => {
    createCustomBlockCalls = []
    isTagTakenCalls = []
    isTagTakenResult = new Set()
    createCustomBlockThrows = new Map()

    app = await buildTestApp({
      routes,
      ajv: true,
      wiki: {
        config: { security: {} },
        sites: { [SITE_ID]: { id: SITE_ID } },
        models: {
          blocks: {
            isTagTaken: async (_siteId: string, tag: string) => {
              isTagTakenCalls.push(tag)
              return isTagTakenResult.has(tag)
            },
            createCustomBlock: async (siteId: string, definition: any, code: Buffer) => {
              const thrown = createCustomBlockThrows.get(definition.block)
              if (thrown) {
                throw thrown
              }
              createCustomBlockCalls.push({ siteId, definition, code })
              return {
                id: `block-id-${definition.block}`,
                block: definition.block,
                name: definition.name,
                description: definition.description,
                icon: definition.icon,
                isEnabled: true,
                isCustom: true,
                config: {},
                props: definition.props ?? [],
                template: definition.template ?? '',
                elementTag: `block-${definition.block}`
              }
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    createCustomBlockCalls = []
    isTagTakenCalls = []
    isTagTakenResult = new Set()
    createCustomBlockThrows = new Map()
  })

  function batchUrl() {
    return `/sites/${SITE_ID}/blocks/batch`
  }

  test('rejects a request with no files without asking the model to create anything', async () => {
    const { payload, contentType } = await buildMultipartPayload([])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 400)
    assert.equal(createCustomBlockCalls.length, 0)
  })

  test('registers every well-formed block in the batch and returns one result per file, in order', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'widget-a.js', content: blockSource('widget-a') },
      { fileName: 'widget-b.js', content: blockSource('widget-b') }
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
    assert.deepEqual(
      body.results.map((r: any) => [r.fileName, r.ok, r.block.block]),
      [
        ['widget-a.js', true, 'widget-a'],
        ['widget-b.js', true, 'widget-b']
      ]
    )
    assert.equal(createCustomBlockCalls.length, 2)
  })

  test('a parse failure fails only its own entry, not the whole batch', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'broken.js', content: 'this is not { valid javascript definition at all ]' },
      { fileName: 'fine.js', content: blockSource('fine') }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'broken.js')
    assert.equal(body.results[0].ok, false)
    assert.equal(typeof body.results[0].message, 'string')
    assert.ok(body.results[0].message.length > 0)
    assert.equal(body.results[1].fileName, 'fine.js')
    assert.equal(body.results[1].ok, true)
    assert.equal(createCustomBlockCalls.length, 1)
  })

  test('a defined-tag mismatch fails only its own entry, not the whole batch', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'mismatch.js', content: blockSource('mismatch', 'block-something-else') },
      { fileName: 'fine.js', content: blockSource('fine2') }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'mismatch.js')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /requires it to register "block-mismatch"/)
    assert.equal(body.results[1].ok, true)
    assert.equal(createCustomBlockCalls.length, 1)
  })

  /**
   * The batch-specific case `isTagTaken()` alone cannot catch: two files in the SAME request both
   * claim tag "dup", and neither is in the database when the second is checked. The route tracks
   * claimed tags itself so the second is refused with a named conflict, not a raw insert failure.
   */
  test('two files in the same batch claiming the same tag: the first wins, the second is refused', async () => {
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'first.js', content: blockSource('dup') },
      { fileName: 'second.js', content: blockSource('dup') }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'first.js')
    assert.equal(body.results[0].ok, true)
    assert.equal(body.results[1].fileName, 'second.js')
    assert.equal(body.results[1].ok, false)
    assert.match(body.results[1].message, /Another file in this batch already registers/)
    assert.equal(createCustomBlockCalls.length, 1)
  })

  test('a tag already taken on the site (built-in or a previously-uploaded custom block) fails only its own entry', async () => {
    isTagTakenResult = new Set(['taken'])
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'taken.js', content: blockSource('taken') },
      { fileName: 'fine.js', content: blockSource('fine3') }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'taken.js')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /already registers the tag "block-taken" on this site/)
    assert.equal(body.results[1].ok, true)
    assert.equal(createCustomBlockCalls.length, 1)
  })

  test('a model failure (e.g. a race lost to blocks_composite_idx) fails only its own entry, not the whole batch', async () => {
    createCustomBlockThrows.set(
      'raced',
      new CustomError('blockTagTaken', 'A block already registers the tag "block-raced".', 409)
    )
    const { payload, contentType } = await buildMultipartPayload([
      { fileName: 'raced.js', content: blockSource('raced') },
      { fileName: 'fine.js', content: blockSource('fine4') }
    ])
    const res = await app.inject({
      method: 'POST',
      url: batchUrl(),
      headers: { 'content-type': contentType },
      payload
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].fileName, 'raced.js')
    assert.equal(body.results[0].ok, false)
    assert.match(body.results[0].message, /already registers the tag/)
    assert.equal(body.results[1].ok, true)
  })

  /**
   * `@fastify/multipart`'s `limits` are read from `WIKI.config.security` once, at
   * plugin-registration time — see `api/assets.batch.test.ts`'s identical describe for the full
   * reasoning (matching `blocks.test.ts`'s existing upload-size-cap precedent).
   */
  describe('registration-time limits (security.uploadMaxFileSize / uploadMaxFilesPerBatch)', () => {
    test('an oversized file fails only its own entry, not the whole batch', async () => {
      // -> Large enough that a genuine `blockSource(...)` fixture (~260 bytes) fits comfortably
      //    under it, so only the deliberately-padded "toobig" file below trips the cap.
      WIKI.config.security.uploadMaxFileSize = 500
      const smallApp = await buildTestApp({ routes, ajv: true })
      try {
        const { payload, contentType } = await buildMultipartPayload([
          { fileName: 'toobig.js', content: `/*${'x'.repeat(1000)}*/\n${blockSource('toobig')}` },
          { fileName: 'fine.js', content: blockSource('fine5') }
        ])
        const res = await smallApp.inject({
          method: 'POST',
          url: batchUrl(),
          headers: { 'content-type': contentType },
          payload
        })
        assert.equal(res.statusCode, 200)
        const body = res.json()
        assert.equal(body.results[0].fileName, 'toobig.js')
        assert.equal(body.results[0].ok, false)
        assert.match(body.results[0].message, /larger than the/)
        assert.equal(body.results[1].fileName, 'fine.js')
        assert.equal(body.results[1].ok, true)
      } finally {
        await closeTestApp(smallApp)
        WIKI.config.security.uploadMaxFileSize = undefined
      }
    })

    test('a batch with more files than the configured per-request limit answers 413, with nothing created', async () => {
      WIKI.config.security.uploadMaxFilesPerBatch = 1
      const smallApp = await buildTestApp({ routes, ajv: true })
      try {
        const { payload, contentType } = await buildMultipartPayload([
          { fileName: 'a.js', content: blockSource('limit-a') },
          { fileName: 'b.js', content: blockSource('limit-b') }
        ])
        const res = await smallApp.inject({
          method: 'POST',
          url: batchUrl(),
          headers: { 'content-type': contentType },
          payload
        })
        assert.equal(res.statusCode, 413)
        assert.match(res.json().message, /1 file limit/)
        assert.equal(createCustomBlockCalls.length, 0)
      } finally {
        await closeTestApp(smallApp)
        WIKI.config.security.uploadMaxFilesPerBatch = undefined
      }
    })
  })
})
