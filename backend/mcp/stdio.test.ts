import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

/**
 * Static wiring checks for the MCP stdio entry point (OpenProject #2197) — `mcp/stdio.ts` is a CLI
 * entry point in the same sense `tasks/migrate.ts` is (`main().catch(...)` runs unconditionally at
 * module scope), so it is never imported directly by a test — see `tasks/migrate.test.ts`'s own header
 * comment for the same convention. The re-verification/shutdown behavior itself is unit-tested in
 * isolation in `mcp/stdioReverify.test.ts`, against the pure `createReverifyingContext()` it wraps.
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
