import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from './db.ts'
import { registerSchemas as registerBlockSchema } from '../api/schemas/block.ts'
import { registerSchemas as registerErrorSchema } from '../api/schemas/error.ts'
import uploadRoutes from '../api/blocks.ts'
import serveRoutes from '../controllers/blocks.ts'
import { registerParamsSchemas } from '../api/schemas/params.ts'

/**
 * The real round trip this task is actually about: a custom block uploaded through
 * `POST /sites/:siteId/blocks` (task 655) has to come back byte-for-byte from
 * `GET /_blocks/custom/:siteId/:blockId.js` (this task) — against a real, migrated database, with
 * neither route's model calls stubbed, unlike `api/blocks.test.ts` and `controllers/blocks.test.ts`'s
 * own unit-level suites.
 *
 * This is as far as this environment can verify the "browser actually executes it" acceptance check
 * short of a literal browser: `index.ts` refuses to boot below Node 26 (`ERROR: Node.js 26.x or later
 * required!`), and this sandbox runs 25.9, so there is no way to bring up the real HTTP server here at
 * all. What this suite CAN prove for certain is that the served bytes are exactly what was uploaded,
 * with the right headers — the part a browser's `import()` actually depends on.
 */
describe(
  'custom block upload -> serve round trip (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let app: FastifyInstance

    before(async () => {
      fixtures = await setupTestDb()
      // -> `installTestWiki()` (`test/db.ts`) leaves `config: {}` -- the upload route reads
      //    `WIKI.config.security?.uploadMaxFileSize`, which is fine left undefined (its own `?? default`
      //    covers that), so nothing needs setting here beyond what `setupTestDb()` already did.

      app = fastify()
      await app.register(fastifySensible)
      // -> `uploadRoutes`/`serveRoutes`' error responses (`$ref: 'ApiError#'`) can't be serialized
      //    without this registered — the schema-build failure surfaces at `app.ready()` for every
      //    route in the plugin, not just the ones this suite exercises.
      await registerErrorSchema(app)
      await registerBlockSchema(app)
      await registerParamsSchemas(app)
      await app.register(uploadRoutes)
      await app.register(serveRoutes, { prefix: '/_blocks/custom' })
      await app.ready()
    })

    after(async () => {
      await app.close()
      await teardownTestDb()
    })

    test('serves an uploaded custom block’s exact source with an immutable cache header', async () => {
      const source = `
export class BlockRoundTrip extends HTMLElement {
  static definition = {
    block: 'round-trip',
    name: 'Round Trip',
    description: 'Proves the upload -> serve path end to end.',
    icon: 'mdi:cube-send'
  }
  connectedCallback () {
    this.attachShadow({ mode: 'open' }).innerHTML = '<span>round trip</span>'
  }
}
customElements.define('block-round-trip', BlockRoundTrip)
`
      const upload = await app.inject({
        method: 'POST',
        url: `/sites/${fixtures.siteId}/blocks`,
        headers: { 'content-type': 'text/javascript' },
        payload: Buffer.from(source)
      })
      assert.equal(upload.statusCode, 200, upload.body)
      const { block } = upload.json()
      assert.equal(block.isCustom, true)
      assert.equal(block.block, 'round-trip')

      const served = await app.inject({
        method: 'GET',
        url: `/_blocks/custom/${fixtures.siteId}/${block.id}.js`
      })

      assert.equal(served.statusCode, 200)
      assert.equal(served.body, source)
      assert.match(served.headers['content-type'] as string, /^application\/javascript/)
      assert.equal(served.headers['cache-control'], 'public, max-age=31536000, immutable')
      assert.ok(served.headers.etag)
    })

    test('404s the serving route for a block id that belongs to a different site', async () => {
      const source = `
export class BlockOtherSite extends HTMLElement {
  static definition = { block: 'other-site', name: 'Other Site', description: 'x', icon: 'mdi:cube' }
}
customElements.define('block-other-site', BlockOtherSite)
`
      const upload = await app.inject({
        method: 'POST',
        url: `/sites/${fixtures.siteId}/blocks`,
        headers: { 'content-type': 'text/javascript' },
        payload: Buffer.from(source)
      })
      const { block } = upload.json()

      const otherSiteId = '99999999-9999-4999-8999-999999999999'
      const served = await app.inject({
        method: 'GET',
        url: `/_blocks/custom/${otherSiteId}/${block.id}.js`
      })

      assert.equal(served.statusCode, 404)
    })
  }
)
