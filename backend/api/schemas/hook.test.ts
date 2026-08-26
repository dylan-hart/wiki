import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastify from 'fastify'
import { registerSchemas } from './hook.ts'

/**
 * Regression coverage for WP 2176: `acceptUntrusted`'s OpenAPI description has to spell out that a
 * configured `authHeader` is still transmitted to the peer even though its certificate is never
 * verified — not just "skip TLS certificate validation", which reads as a purely transport-level
 * knob. Checked on both `HookInput` (create/update) and `HookTestInput` (`POST /_api/hooks/test`,
 * which shares `postJson()` with real deliveries), since each declares its own copy of the property.
 *
 * Reads the schemas back out of Fastify (`app.getSchema`) rather than re-implementing a copy of
 * `hook.ts`'s object literals, so this fails the moment the real registration drifts from what is
 * asserted here.
 */
test('acceptUntrusted describes its Authorization-header consequence on HookInput and HookTestInput', async () => {
  const app = fastify()
  await registerSchemas(app)
  await app.ready()

  for (const schemaId of ['HookInput', 'HookTestInput']) {
    const schema = app.getSchema(schemaId) as any
    const description = schema.properties.acceptUntrusted.description as string

    assert.match(
      description,
      /authorization/i,
      `${schemaId}.acceptUntrusted description should mention the Authorization header`
    )
    assert.match(
      description,
      /never verified|not verified|unverified/i,
      `${schemaId}.acceptUntrusted description should state the peer's certificate isn't verified`
    )
  }

  await app.close()
})
