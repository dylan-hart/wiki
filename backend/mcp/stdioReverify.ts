/**
 * The stdio transport's periodic re-verification of its one configured API key. `mcp/http.ts`
 * re-verifies the bearer token on every request; stdio has no request to hang that on, so without
 * this a key's revocation, expiry and its owner's groups and permissions would be frozen at boot.
 * A failing verify (revoked, expired, or the model call itself erroring) stops the timer and goes to
 * `onRevoked`.
 */

import { authenticateApiKey, type McpAuthContext, type McpAuthContextGetter } from './auth.ts'

/** How stale the cached context may get before the next tick refreshes it. */
export const REVERIFY_INTERVAL_MS = 30_000

export interface ReverifyingContext {
  getCtx: McpAuthContextGetter
  /** Exposed for tests; production runs it on the timer. */
  reverify: () => Promise<void>
  /**
   * For a context verified elsewhere (`reverifyOnToolCall` in `mcp/stdio.ts`), so both re-verify
   * paths share this one cache rather than tracking divergent contexts.
   */
  setCtx: (ctx: McpAuthContext) => void
  stop: () => void
}

/**
 * `onRevoked` is called once, the first time a re-verify fails. `verify` and `intervalMs` are
 * injectable for tests.
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
      // -> Stop before handing off: `onRevoked` may end the process, and a tick during that shutdown
      //    would race it.
      stop()
      await onRevoked(err)
    }
  }

  const timer: NodeJS.Timeout = setInterval(() => {
    void reverify()
  }, intervalMs)
  // -> This timer must never be what keeps the process alive, even if `stop()` is never called.
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
    setCtx: (fresh: McpAuthContext) => {
      ctx = fresh
    },
    stop
  }
}
