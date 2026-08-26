import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReverifyingContext } from './stdioReverify.ts'
import type { McpAuthContext } from './auth.ts'

const INITIAL_CTX: McpAuthContext = {
  keyId: 'key-1',
  permissions: ['read:users'],
  siteId: null,
  groupIds: ['group-a'],
  userId: null,
  scope: null
}

test('createReverifyingContext: getCtx returns the initial context before any tick', () => {
  const { getCtx } = createReverifyingContext(
    'token',
    INITIAL_CTX,
    () => {},
    async () => INITIAL_CTX,
    // -> Interval irrelevant here; nothing calls reverify() in this test.
    1_000_000
  )
  assert.deepEqual(getCtx(), INITIAL_CTX)
})

test('createReverifyingContext: reverify() refreshes the cached context on success — a permission removed from the group after boot is no longer honoured on the next call', async () => {
  const REFRESHED_CTX: McpAuthContext = { ...INITIAL_CTX, permissions: [] }
  const { getCtx, reverify } = createReverifyingContext(
    'token',
    INITIAL_CTX,
    () => {
      throw new Error('onRevoked must not be called on a successful re-verify')
    },
    async () => REFRESHED_CTX,
    1_000_000
  )
  assert.deepEqual(getCtx(), INITIAL_CTX)
  await reverify()
  assert.deepEqual(getCtx(), REFRESHED_CTX)
})

test('createReverifyingContext: a revoked key stops a subsequent tool call and triggers onRevoked (shutdown)', async () => {
  let onRevokedCalls: any[] = []
  const { getCtx, reverify } = createReverifyingContext(
    'token',
    INITIAL_CTX,
    (err: any) => {
      onRevokedCalls.push(err)
    },
    async () => {
      throw new Error('API key is revoked')
    },
    1_000_000
  )
  await reverify()
  assert.equal(onRevokedCalls.length, 1)
  assert.match(onRevokedCalls[0].message, /revoked/)
  // -> The last-known-good context is not silently kept around and re-served after the key fails —
  //    the caller (mcp/stdio.ts) shuts the process down through `onRevoked` instead of continuing to
  //    dispatch tool calls, so what getCtx() returns after this point does not matter for a real
  //    caller, but must not itself throw.
  assert.doesNotThrow(() => getCtx())
})

test('createReverifyingContext: onRevoked fires only once even if reverify() is called again after failing', async () => {
  let onRevokedCalls = 0
  let verifyCalls = 0
  const { reverify } = createReverifyingContext(
    'token',
    INITIAL_CTX,
    () => {
      onRevokedCalls++
    },
    async () => {
      verifyCalls++
      throw new Error('revoked')
    },
    1_000_000
  )
  await reverify()
  await reverify()
  assert.equal(onRevokedCalls, 1)
  // -> stop() runs before onRevoked is awaited, so a second manual reverify() after the first failure
  //    is a no-op rather than calling the (possibly already-shutting-down) verify function again.
  assert.equal(verifyCalls, 1)
})

test('createReverifyingContext: stop() prevents a subsequent reverify() from calling verify or onRevoked', async () => {
  let verifyCalls = 0
  let onRevokedCalls = 0
  const { reverify, stop } = createReverifyingContext(
    'token',
    INITIAL_CTX,
    () => {
      onRevokedCalls++
    },
    async () => {
      verifyCalls++
      return INITIAL_CTX
    },
    1_000_000
  )
  stop()
  await reverify()
  assert.equal(verifyCalls, 0)
  assert.equal(onRevokedCalls, 0)
})

test('createReverifyingContext: ticks on its own via the timer, without an explicit reverify() call', async () => {
  let verifyCalls = 0
  const { getCtx, stop } = createReverifyingContext(
    'token',
    INITIAL_CTX,
    () => {},
    async () => {
      verifyCalls++
      return { ...INITIAL_CTX, permissions: [] }
    },
    // -> Short enough for the test to observe a real tick without a fake-timers dependency.
    5
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  stop()
  assert.ok(verifyCalls >= 1, 'expected the background timer to have ticked at least once')
  assert.deepEqual(getCtx().permissions, [])
})
