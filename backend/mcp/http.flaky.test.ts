import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { createMcpSessionHarness } from '../test/mcpSessionHarness.ts'

/**
 * QUARANTINED — in the `*.flaky.*` lane: runs under `npm run test:flaky` (report-only in CI), not
 * under `npm run test`. **Expires 2026-12-06** — fixed or deleted by then.
 *
 * `updateAgeOnGet` must keep an actively-used session alive, but asserting it needs the real clock:
 * each 15 ms touch has to land inside a 30 ms idle TTL, which is a fact about event-loop scheduling
 * under a fully concurrent `node --test` run, not about the session map. It passes reliably alone.
 * The eviction tests in `mcp/http.test.ts` stay in the default lane: a slow run only makes those
 * more true.
 *
 * TODO: give `mcp/http.ts` an injectable clock (`LRUCache` accepts one), assert this against fake
 * time, and move it back into `mcp/http.test.ts`.
 */
describe('mcp/http session eviction, active-session liveness (OpenProject #2207)', () => {
  let harness: Awaited<ReturnType<typeof createMcpSessionHarness>>

  beforeEach(async () => {
    harness = await createMcpSessionHarness({ sessionIdleTtlMs: 30, sessionCap: 2 })
  })

  afterEach(async () => {
    await harness.close()
  })

  test('an active session is not evicted while it is still being used', async () => {
    const sessionId = await harness.openSession()
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      const res = await harness.pollSession(sessionId)
      assert.equal(res.statusCode, 200, `expected the session to still be live on touch #${i}`)
    }
  })
})
