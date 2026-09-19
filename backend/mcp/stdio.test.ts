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
 * The re-verify wiring lives inside `mcp/stdio.ts`'s `main()`, which only runs as an entry point, so
 * the `describe` block below asserts it structurally over the source text; `stdioReverify.test.ts`
 * covers the timer/shutdown behaviour itself. Importing the module is otherwise side-effect free --
 * the console overrides, signal handlers and `main()` call are all gated on `isEntryPoint`.
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

  transport.onmessage(toolCallMessage(1))
  await flush()
  assert.equal(dispatched.length, 1)
  assert.equal(shutdownCalls.length, 0)

  // Revoked between calls: a stdio process is one long-lived session, so nothing else re-checks.
  verifyImpl = async () => {
    throw new ApiKeyError('API key has been revoked.')
  }

  transport.onmessage(toolCallMessage(2))
  await flush()

  assert.equal(dispatched.length, 1)
  // `main()` wires onVerifyFailed to shutdown(1).
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

  // Not a revocation: the token still verifies, only the owner's permissions shrink.
  verifyImpl = async () => ({ ...IDENTITY_FULL, permissions: [] })

  transport.onmessage(toolCallMessage(2))
  await flush()

  assert.deepEqual(applyCalls[1].permissions, [])
  // Both calls still dispatch: a lost permission refuses inside the tool handler, off the refreshed
  // ctx, rather than blocking the call the way a revoked key does.
  assert.equal(dispatched.length, 2)
})
