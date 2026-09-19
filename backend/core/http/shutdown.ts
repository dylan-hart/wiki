import { EventEmitter } from 'node:events'
import closeWithGrace from 'close-with-grace'
import type { FastifyInstance, FastifyReply } from 'fastify'

/**
 * `close-with-grace` drives the signal/error handling and the process exit (0 graceful, 1 crash);
 * this module adds the `/_live`/`/_ready` probes, the pre-close delay and the two events
 * `./server.ts#registerShutdownLogging` consumes.
 */

/** Emitted once teardown begins, with its reason: an `Error` whose `message` is the bare signal
 * name for a signal-triggered shutdown, the real `Error` for an `uncaughtException`-triggered one,
 * or `undefined` for a programmatic `close()`. */
export const SHUTTING_DOWN = 'SHUTTING_DOWN'

/** Emitted after `app.close()` — the last thing before close-with-grace calls `process.exit()`. */
export const SHUTDOWN = 'SHUTDOWN'

/**
 * A delay *before* the close tasks run, not a timeout wrapping them — long enough for `/_ready`'s
 * 503 to reach a load balancer or kube-proxy and stop new traffic, while staying under a typical
 * 30s Kubernetes `terminationGracePeriodSeconds` once the close tasks' own bounds are added on top.
 */
export const PRE_CLOSE_DELAY_MS = 5000

/**
 * The part of close-with-grace's default event set this module does not want:
 *
 * - The signals beyond SIGINT/SIGTERM/SIGHUP — several of them (SIGILL, SIGBUS, SIGFPE, SIGSEGV)
 *   are ones Node's own docs say cannot be safely handled from JavaScript at all.
 * - `unhandledRejection`: `core/processGuards.ts` stays the sole owner of that event.
 * - `beforeExit`: not a shutdown signal, and it would fire spuriously in-process under
 *   `node --test`.
 */
const SKIPPED_EVENTS = [
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGSEGV',
  'SIGUSR2',
  'unhandledRejection',
  'beforeExit'
] as const

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The shape `close-with-grace` hands its callback — narrowed to the two fields this module reads. */
export interface ShutdownReason {
  signal?: string
  err?: Error
}

/**
 * Exported standalone so a test can drive it without `close-with-grace`'s real `process` signal
 * handlers and its `process.exit()` at the end.
 *
 * The order is load-bearing: `SHUTTING_DOWN` first (so `stopping` is logged when the teardown
 * STARTS), then the pre-close delay, then `closeTasks` via `Promise.allSettled` (each must bound
 * itself, or a hanging one holds up the socket close), then `app.close()`, then `SHUTDOWN`.
 */
export async function runShutdownSequence(
  reason: ShutdownReason,
  // -> Not `Pick<FastifyInstance, 'close'>`: Fastify types `close()` as `Promise<undefined>`, which
  //    a test's own `async () => {}` stand-in would not satisfy.
  app: { close: () => Promise<unknown> },
  closeTasks: Array<() => Promise<unknown>>,
  emitter: Pick<EventEmitter, 'emit'>,
  onShuttingDown: () => void,
  opts: { preCloseDelayMs?: number } = {}
): Promise<void> {
  onShuttingDown()
  const error = reason.signal ? new Error(reason.signal) : reason.err
  emitter.emit(SHUTTING_DOWN, error)

  const preCloseDelayMs = opts.preCloseDelayMs ?? PRE_CLOSE_DELAY_MS
  if (preCloseDelayMs > 0) {
    await sleep(preCloseDelayMs)
  }

  await Promise.allSettled(closeTasks.map((task) => task()))
  await app.close()

  emitter.emit(SHUTDOWN)
}

/**
 * Ordinary routes, with no bypass of the request pipeline needed: `siteRouting.ts#isPageUrl`
 * already excludes every leading-underscore path from the SEO/site-resolution hooks, and
 * `authHooks.ts`'s auth and rate-limit hooks are path-scoped and match neither.
 *
 * `/_live` is independent of `isReady` — a liveness probe asks only "is this process alive".
 * `/_ready` answers 200 once `index.ts` calls `CARDINAL.server.setReady()` after `postBoot()`, and
 * 503 from the moment teardown starts.
 */
export function registerProbes(app: FastifyInstance, isReady: () => boolean): void {
  app.get('/_live', async () => ({ status: 'ok' }))
  app.get('/_ready', async (_req, reply: FastifyReply) => {
    if (!isReady()) {
      reply.code(503)
      return { status: 'not ready' }
    }
    return { status: 'ok' }
  })
}

/** What `CARDINAL.server` is typed as — see `types/global.d.ts`. */
export interface ShutdownController {
  on: EventEmitter['on']
  setReady: () => void
  isReady: () => boolean
  /** Removes every listener `close-with-grace` installed on `process` — test cleanup only. */
  uninstall: () => void
}

/**
 * `delay: false` disables close-with-grace's own hard kill timer (distinct from the pre-close
 * delay, which `runShutdownSequence` always runs): each close task already bounds itself, and a
 * second signal still gets close-with-grace's immediate `process.exit(1)` regardless.
 */
export function createGracefulShutdown(
  app: { close: () => Promise<unknown> },
  closeTasks: Array<() => Promise<unknown>>
): ShutdownController {
  const emitter = new EventEmitter()
  let ready = false
  let shuttingDown = false

  const gracefulClose = closeWithGrace(
    {
      delay: false,
      // -> close-with-grace's own diagnostics (a second signal/error while already closing), routed
      //    through CARDINAL.logger rather than left on stdout in a second shape.
      logger: {
        error: (message?: unknown, ...rest: unknown[]) =>
          CARDINAL.logger.warn('boot', [message, ...rest].filter(Boolean).join(' '))
      },
      skip: [...SKIPPED_EVENTS]
    },
    ({ err, signal }) =>
      runShutdownSequence({ signal, err }, app, closeTasks, emitter, () => {
        shuttingDown = true
      })
  )

  return {
    on: emitter.on.bind(emitter),
    setReady: () => {
      ready = true
    },
    isReady: () => ready && !shuttingDown,
    uninstall: gracefulClose.uninstall
  }
}
