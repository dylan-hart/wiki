/**
 * The stdio transport's periodic re-verification of its one configured API key (OpenProject #2197).
 *
 * Split out of `mcp/stdio.ts` itself so it can be unit-tested without executing that file's `main()` —
 * `mcp/stdio.ts` is a CLI entry point in the same sense `tasks/migrate.ts` is (see that file's own
 * `*.test.ts` for the convention this follows): importing it runs the process, so the logic worth
 * testing in isolation lives here instead.
 *
 * `mcp/stdio.ts` resolves its auth context once at startup and, before this, handed every tool call for
 * the rest of the process's life a fixed `() => ctx` getter — so a key's revoked/expired state, its
 * owner's `isActive` flag, group membership and flattened permissions were all frozen at boot. The HTTP
 * transport (`mcp/http.ts`) has no equivalent problem: it re-verifies the bearer token on every request.
 * stdio has no per-call HTTP request to hang a re-verify on, so this re-verifies on a short timer
 * instead — `authenticateApiKey(token)` on every tick — and once that starts failing (revoked, expired,
 * or the underlying model call itself errors), stops ticking and hands the failure to the caller-supplied
 * `onRevoked`, which `mcp/stdio.ts` wires to its existing `shutdown()` path.
 */

import { authenticateApiKey, type McpAuthContext, type McpAuthContextGetter } from './auth.ts'

/** How stale the cached context may get before the next tick refreshes it. */
export const REVERIFY_INTERVAL_MS = 30_000

export interface ReverifyingContext {
  /** Wired straight into `registerAllTools()` — always reads the most recently verified context. */
  getCtx: McpAuthContextGetter
  /** Runs one verification cycle immediately. Exposed for tests; production also runs it on a timer. */
  reverify: () => Promise<void>
  /** Stops the background timer. Idempotent. */
  stop: () => void
}

/**
 * @param token The bearer token to re-verify — the same one `authenticateApiKey()` checked at startup.
 * @param initialCtx The context already resolved once at startup, so the first `getCtx()` needs no wait.
 * @param onRevoked Called (once) the first time a re-verify fails — `mcp/stdio.ts` shuts the process down
 *                   through its existing `shutdown()` path here, rather than this module knowing about
 *                   process exit codes or the db pool it needs to close first.
 * @param verify Injectable for tests; defaults to the real `authenticateApiKey()`.
 * @param intervalMs Injectable for tests, so a suite is not stuck waiting on the real interval.
 */
export function createReverifyingContext(
  token: string,
  initialCtx: McpAuthContext,
  onRevoked: (err: any) => void | Promise<void>,
  verify: (token: string) => Promise<McpAuthContext> = authenticateApiKey,
  intervalMs: number = REVERIFY_INTERVAL_MS
): ReverifyingContext {
  let ctx = initialCtx
  let stopped = false

  async function reverify(): Promise<void> {
    if (stopped) {
      return
    }
    try {
      ctx = await verify(token)
    } catch (err: any) {
      // -> Stop ticking before handing off: `onRevoked` may itself end the process, and a timer firing
      //    again during that shutdown would race it for no benefit.
      stop()
      await onRevoked(err)
    }
  }

  const timer: NodeJS.Timeout = setInterval(() => {
    void reverify()
  }, intervalMs)
  // -> A live re-verify timer must not be the one thing keeping the process alive once the transport
  //    itself has closed — `mcp/stdio.ts` also calls `stop()` on `transport.onclose`, but `unref()` is
  //    the belt-and-braces version that costs nothing even if that call is ever missed.
  timer.unref?.()

  function stop(): void {
    if (stopped) {
      return
    }
    stopped = true
    clearInterval(timer)
  }

  return {
    getCtx: () => ctx,
    reverify,
    stop
  }
}
