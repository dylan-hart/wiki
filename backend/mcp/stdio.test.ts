import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, test } from 'node:test'
import { ApiKeyError } from '../models/apiKeys.ts'
import type { McpAuthContext } from './auth.ts'
import { reverifyOnToolCall } from './stdio.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Two kinds of coverage for the MCP stdio entry point's re-verification (OpenProject #2197):
 *
 *  - Static wiring checks (`describe('mcp/stdio.ts wiring', ...)` below) — `mcp/stdio.ts` is a CLI
 *    entry point in the same sense `tasks/migrate.ts` is (`main().catch(...)` runs unconditionally at
 *    module scope), so its timer-based re-verify wiring is never exercised by importing the module
 *    directly; see `tasks/migrate.test.ts`'s own header comment for the same convention. The
 *    timer/shutdown behavior itself is unit-tested in isolation in `mcp/stdioReverify.test.ts`, against
 *    the pure `createReverifyingContext()` `mcp/stdio.ts` wraps.
 *  - Direct behavioral tests of `reverifyOnToolCall` (below the `describe` block) — importing
 *    `stdio.ts` itself for this is safe: everything that behaves like a running CLI server (console
 *    overrides, signal handlers, calling `main()`) is gated on `isEntryPoint`, which is false for an
 *    import. `WIKI.models.apiKeys.verify` is mocked so no database is touched — the same pattern
 *    `auth.test.ts` uses for `authenticateApiKey`, which this indirectly re-exercises on every
 *    simulated tool call.
 */

const mcpDir = path.dirname(fileURLToPath(import.meta.url))

async function readMcpFile(relativePath: string): Promise<string> {
  return readFile(path.join(mcpDir, relativePath), 'utf8')
}

describe('mcp/stdio.ts wiring', () => {
  test('registers tools against the re-verifying getter, not a fixed closure', async () => {
    const source = await readMcpFile('stdio.ts')
    assert.match(source, /createReverifyingContext\(/)
    assert.match(source, /registerAllTools\(server, reverifying\.getCtx\)/)
    assert.doesNotMatch(source, /registerAllTools\(server, \(\) => ctx\)/)
  })

  test('a failed re-verification is routed through the existing shutdown() path', async () => {
    const source = await readMcpFile('stdio.ts')
    // -> The onRevoked callback passed to createReverifyingContext must itself call shutdown(1) —
    //    checked structurally since exercising it end-to-end would mean spawning this file as a real
    //    child process (it needs its own stdin/stdout, per the file's own header comment).
    const callbackMatch = source.match(
      /createReverifyingContext\(token, ctx, async \(err: any\) => \{([\s\S]*?)\}\)/
    )
    assert.ok(
      callbackMatch,
      'expected an inline onRevoked callback passed to createReverifyingContext'
    )
    assert.match(callbackMatch![1], /shutdown\(1\)/)
  })

  test('the transport close handler stops the re-verify timer before shutting down', async () => {
    const source = await readMcpFile('stdio.ts')
    const closeHandlerMatch = source.match(/transport\.onclose = \(\) => \{([\s\S]*?)\}/)
    assert.ok(closeHandlerMatch, 'expected an onclose handler on the stdio transport')
    assert.match(closeHandlerMatch![1], /reverifying\.stop\(\)/)
    assert.match(closeHandlerMatch![1], /shutdown\(0\)/)
  })
})

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

let wikiHandle: { restore(): void }
let verifyImpl: (token: string) => Promise<any>

before(() => {
  wikiHandle = installTestWiki({
    models: {
      apiKeys: {
        verify: async (token: string) => verifyImpl(token)
      }
    }
  })
})

after(() => {
  wikiHandle.restore()
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
