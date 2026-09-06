import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { createMcpSessionHarness } from '../test/mcpSessionHarness.ts'

/**
 * QUARANTINED — this file is in the `*.flaky.*` lane and does NOT run under `npm run test`. It runs
 * under `npm run test:flaky`, which CI reports on but does not gate on. See
 * `docs/decisions/flaky-test-quarantine.md` for the lane's rules.
 *
 * **Expires 2026-12-06.** By then this test is either fixed or deleted.
 *
 * **Why it is here.** The claim is real and worth holding: `mcp/http.ts`'s session map is built with
 * `updateAgeOnGet`, so touching a session must keep resetting its idle clock and an actively-used
 * session must never be evicted underneath its client. But the only way to assert it in a unit test
 * is to run the real clock — open a session, touch it five times at 15 ms intervals against a
 * deliberately tiny 30 ms idle TTL, and require every touch to land inside the previous one's
 * window. Whether a 15 ms `setTimeout` plus one `app.inject()` round trip completes inside 30 ms is
 * a fact about the whole run's event-loop scheduling under ~400 concurrent `node --test` file
 * processes, not about the session map. It passes reliably when run alone.
 *
 * Its two siblings in `mcp/http.test.ts` assert that eviction HAPPENS (idle expiry, and the hard
 * cap); a slow run only makes those more true, so they stayed in the default lane. This one is the
 * only direction that a slow run can falsify.
 *
 * **The fix that retires it.** `mcp/http.ts` takes `sessionIdleTtlMs`/`sessionCap` as options
 * already; giving it an injectable clock too (`LRUCache` accepts one) would let this be asserted
 * against fake time with no wall-clock margin at all, at which point it belongs back in
 * `mcp/http.test.ts` and this file goes away. That is the intended outcome — not a renewal.
 */
describe('mcp/http session eviction, active-session liveness (OpenProject #2207)', () => {
  let harness: Awaited<ReturnType<typeof createMcpSessionHarness>>

  // -> Same tiny idle ttl and cap-of-2 harness `mcp/http.test.ts`'s eviction describe builds, so
  //    this test's subject is unchanged by having been split out.
  beforeEach(async () => {
    harness = await createMcpSessionHarness({ sessionIdleTtlMs: 30, sessionCap: 2 })
  })

  afterEach(async () => {
    await harness.close()
  })

  test('an active session is not evicted while it is still being used', async () => {
    const sessionId = await harness.openSession()
    // -> Repeatedly touch the session across a span longer than the idle ttl, with each touch well
    //    inside the ttl window of the previous one — `updateAgeOnGet` should keep resetting its clock.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      const res = await harness.pollSession(sessionId)
      assert.equal(res.statusCode, 200, `expected the session to still be live on touch #${i}`)
    }
  })
})
