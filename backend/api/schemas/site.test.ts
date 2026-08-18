import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastify from 'fastify'
import { registerSchemas } from './site.ts'

/**
 * Regression coverage for task 489: `editors.code` has to be registered on the shared `Site` schema
 * exactly the way `asciidoc`/`markdown`/`wysiwyg` are (`isActive`/`config`) — otherwise a PUT to
 * `sites/:siteId` carrying `editors: { code: { isActive: true } }` (what `AdminEditors.vue`'s `save()`
 * sends) is silently stripped by Fastify's schema-based serialization/validation rather than reaching
 * the model, and the code editor could never actually be turned on for a site.
 *
 * Reads the schema back out of Fastify (`app.getSchema`) rather than re-implementing its own copy of
 * `site.ts`'s object literal, so this fails the moment the real registration drifts from what is
 * asserted here.
 */
test('the Site schema registers editors.code alongside asciidoc/markdown/wysiwyg', async () => {
  const app = fastify()
  await registerSchemas(app)
  await app.ready()

  const siteSchema = app.getSchema('Site') as any
  const editors = siteSchema.properties.editors.properties

  assert.ok(editors.code, 'editors.code is missing from the Site schema')
  assert.deepEqual(
    editors.code,
    editors.markdown,
    'editors.code should have the same shape as editors.markdown'
  )

  await app.close()
})
