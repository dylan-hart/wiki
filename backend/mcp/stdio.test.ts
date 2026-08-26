import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { ApiKeyError } from '../models/apiKeys.ts'
import type { McpAuthContext } from './auth.ts'
import { reverifyOnToolCall } from './stdio.ts'

/**
 * Exercises `reverifyOnToolCall` directly against a stub transport rather than a real
 * `StdioServerTransport` (stdin/stdout) -- see that function's own doc comment for why. Importing
 * `stdio.ts` itself is safe: everything that behaves like a running CLI server (console overrides,
 * signal handlers, calling `main()`) is gated on `isEntryPoint`, which is false for an import.
 * `WIKI.models.apiKeys.verify` is mocked so no database is touched -- the same pattern `auth.test.ts`
 * uses for `authenticateApiKey`, which this indirectly re-exercises on every simulated tool call.
 */

const TOKEN = 'wiki-mcp-token'
const IDENTITY_FULL = {
  id: 'key-1',
  permissions: ['manage:pages'],
  siteId: null,
  groupIds: ['group-a'],
  userId: 'user-1',
  scope: null,
  allowedClassifications: null
}

let previousWiki: any
let verifyImpl: (token: string) => Promise<any>

before(() => {
  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = {
    models: {
      apiKeys: {
        verify: async (token: string) => verifyImpl(token)
      }
    }
  }
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

beforeEach(() => {
  verifyImpl = async (token: string) => {
    if (token === TOKEN) {
      return IDENTITY_FULL
    }
    throw new ApiKeyError('API key has been revoked.')
  }
})

function stubTransport() {
  const dispatched: unknown[] = []
  const transport = {
    onmessage: (message: unknown) => {
      dispatched.push(message)
    }
  }
  return { transport, dispatched }
}

function toolCallMessage(id: number | string = 1) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call',
    params: { name: 'list_sites', arguments: {} }
  }
}

/** Lets the microtask chain inside `reverifyOnToolCall`'s fire-and-forget `handle()` settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('a non-tools/call message passes through untouched, with no re-verification', async () => {
  const { transport, dispatched } = stubTransport()
  const applyCalls: McpAuthContext[] = []
  reverifyOnToolCall(
    transport,
    TOKEN,
    (ctx) => applyCalls.push(ctx),
    async () => {}
  )

  const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' }
  transport.onmessage(message)
  await flush()

  assert.deepEqual(dispatched, [message])
  assert.equal(applyCalls.length, 0)
})

test('a tools/call message re-verifies the token and forwards the message once it resolves', async () => {
  const { transport, dispatched } = stubTransport()
  const applyCalls: McpAuthContext[] = []
  reverifyOnToolCall(
    transport,
    TOKEN,
    (ctx) => applyCalls.push(ctx),
    async () => {}
  )

  const message = toolCallMessage()
  transport.onmessage(message)
  await flush()

  assert.equal(applyCalls.length, 1)
  assert.equal(applyCalls[0].keyId, 'key-1')
  assert.deepEqual(dispatched, [message])
})

test('a revoked key stops a subsequent tool call from reaching the dispatch, and triggers shutdown', async () => {
  const { transport, dispatched } = stubTransport()
  const applyCalls: McpAuthContext[] = []
  const shutdownCalls: any[] = []
  reverifyOnToolCall(
    transport,
    TOKEN,
    (ctx) => applyCalls.push(ctx),
    async (err) => {
      shutdownCalls.push(err)
    }
  )

  // First call succeeds -- the key is still valid at this point.
  transport.onmessage(toolCallMessage(1))
  await flush()
  assert.equal(dispatched.length, 1)
  assert.equal(shutdownCalls.length, 0)

  // The key is revoked between calls, with no new session -- same long-lived stdio process.
  verifyImpl = async () => {
    throw new ApiKeyError('API key has been revoked.')
  }

  transport.onmessage(toolCallMessage(2))
  await flush()

  // The revoked call never reaches the dispatch (no tool handler runs against a stale identity)...
  assert.equal(dispatched.length, 1)
  // ...and the failure is handed to onVerifyFailed instead, which main() wires to shutdown().
  assert.equal(shutdownCalls.length, 1)
  assert.match(shutdownCalls[0].message, /revoked/)
})

test('a permission removed from the owner group after boot is no longer honoured on the next call', async () => {
  const { transport, dispatched } = stubTransport()
  const applyCalls: McpAuthContext[] = []
  reverifyOnToolCall(
    transport,
    TOKEN,
    (ctx) => applyCalls.push(ctx),
    async () => {}
  )

  transport.onmessage(toolCallMessage(1))
  await flush()
  assert.deepEqual(applyCalls[0].permissions, ['manage:pages'])

  // The owner's group loses manage:pages -- the next verify resolves fine (the token itself is still
  // valid), just with a smaller McpAuthContext.
  verifyImpl = async () => ({ ...IDENTITY_FULL, permissions: [] })

  transport.onmessage(toolCallMessage(2))
  await flush()

  assert.deepEqual(applyCalls[1].permissions, [])
  // Both calls still reach the dispatch -- losing a permission refuses at the tool-handler layer
  // (checkAccess reading the just-updated ctx), not by blocking the call outright the way a
  // revoked/expired key does.
  assert.equal(dispatched.length, 2)
})
