import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastify from 'fastify'
import fastifySwagger from '@fastify/swagger'
import hooksRoutes from './hooks.ts'
import { registerSchemas as registerHookSchema } from './schemas/hook.ts'
import { EMITTED_EVENTS, HOOK_EVENTS } from '../models/hooks.ts'

/**
 * Regression test for task 640: `GET /_api/hooks/events`'s Swagger `description` is a hand-written
 * string that has to be kept in sync with {@link EMITTED_EVENTS} by hand — nothing enforces that at
 * the type level, which is exactly how it went stale before (it used to claim only `user:*` events
 * were emitted, well after `page:*` and `asset:*` had emit points too).
 *
 * This suite pins two things so the same class of bug is caught the next time `EMITTED_EVENTS`
 * changes without a matching edit to the description:
 *
 * 1. The description does not contain any of the specific stale claims the string has carried before
 *    (naming only `user:*` as emitted, or saying comments "are not implemented yet").
 * 2. The response's `isEmitted` flags actually agree with {@link EMITTED_EVENTS} for every event.
 *
 * `WIKI` is not stubbed because `GET /events` reads only the two plain exports above — no model,
 * cache or db access.
 */

async function buildApp() {
  const app = fastify()
  await app.register(fastifySwagger)
  registerHookSchema(app)
  await app.register(hooksRoutes)
  await app.ready()
  return app
}

test('GET /events response reflects EMITTED_EVENTS for every catalogued event', async () => {
  const app = await buildApp()
  try {
    const res = await app.inject({ method: 'GET', url: '/events' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { key: string; isEmitted: boolean }[]
    assert.deepEqual(
      body.map((e) => e.key),
      HOOK_EVENTS as unknown as string[]
    )
    for (const entry of body) {
      assert.equal(
        entry.isEmitted,
        (EMITTED_EVENTS as string[]).includes(entry.key),
        `isEmitted for ${entry.key} should match EMITTED_EVENTS`
      )
    }
    // Comment events specifically: this is the fact the description was stale about.
    const commentEntries = body.filter((e) => e.key.startsWith('comment:'))
    assert.ok(commentEntries.length > 0)
    for (const entry of commentEntries) {
      assert.equal(entry.isEmitted, true, `${entry.key} should be reported as emitted`)
    }
  } finally {
    await app.close()
  }
})

test('GET /events Swagger description does not repeat known-stale claims', async () => {
  const app = await buildApp()
  try {
    const spec = app.swagger() as any
    const description = spec.paths['/events'].get.description as string
    // The description this task fixed: it used to say only `user:*` events were emitted and that
    // pages/assets/comments were not implemented yet. Both claims are false now.
    assert.doesNotMatch(description, /only the `user:\*` events/i)
    assert.doesNotMatch(description, /pages, assets and comments are not implemented/i)
    // Comments are the one remaining gap the description is allowed to call out today (Feature 399
    // task 1 will close it) — but it must not claim comments are unimplemented, since they are wired
    // via `api/comments.ts`'s `emitCommentEvent()`.
    assert.doesNotMatch(description, /comments? (is|are) not (yet )?implemented/i)
  } finally {
    await app.close()
  }
})
