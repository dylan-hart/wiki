import { EventEmitter } from 'node:events'
import closeWithGrace from 'close-with-grace'
import type { FastifyInstance, FastifyReply } from 'fastify'

/**
 * Replaces `@gquittet/graceful-server` (269 commits from one maintainer, 40k downloads/wk — see
 * `docs/audits/2026-09-13-dependency-audit.md` §3 and section A): `close-with-grace` (mcollina,
 * 353k/wk, the pattern the Fastify docs themselves use) drives the signal/error handling and the
 * process exit, and this module supplies what the old library used to bundle in for free — the
 * `/_live`/`/_ready` probes and the pre-close delay — plus the two events
 * `registerShutdownLogging` (`./server.ts`) already consumes.
 *
 * The observable contract this preserves (OpenProject #3156): the probe paths and status codes, the
 * 5s pre-close delay, the close ordering (scheduler, collab, db), the `SHUTTING_DOWN`/`SHUTDOWN`
 * event pair, and the signal set (SIGINT, SIGTERM, SIGHUP). What it does NOT preserve is the old
 * library's per-signal exit code (1 for SIGHUP, 2 for SIGINT, 15 for SIGTERM) — not part of that
 * enumerated contract, and not worth reimplementing against close-with-grace's own plain 0
 * (graceful)/1 (crash) convention.
 */

/** Emitted once teardown begins, carrying the same reason shape the replaced library did: an `Error`
 * whose `message` is the bare signal name for a signal-triggered shutdown, the real `Error` for an
 * `uncaughtException`-triggered one, or `undefined` for a programmatic `close()`. */
export const SHUTTING_DOWN = 'SHUTTING_DOWN'

/** Emitted once the pre-close delay, the close tasks and `app.close()` have all finished — the very
 * last thing before close-with-grace calls `process.exit()` itself. */
export const SHUTDOWN = 'SHUTDOWN'

/**
 * Spent entirely as a pre-close delay *before* the close tasks run (not a timeout wrapping them) —
 * long enough for `/_ready`'s 503 to reach a load balancer or kube-proxy and for it to stop routing
 * new traffic here, while staying comfortably under a typical 30s Kubernetes
 * `terminationGracePeriodSeconds` once the close tasks' own bounds are added on top. Matches the
 * replaced library's `timeout` option.
 */
export const PRE_CLOSE_DELAY_MS = 5000

/**
 * The part of close-with-grace's default event set this module does not want:
 *
 * - The eight signals beyond SIGINT/SIGTERM/SIGHUP are not part of this WP's signal-set contract —
 *   several of them (SIGILL, SIGBUS, SIGFPE, SIGSEGV) are ones Node's own docs say cannot be safely
 *   handled from JavaScript at all.
 * - `unhandledRejection`: `core/processGuards.ts` stays the sole owner of that event (see its own
 *   doc comment) — skipping it here is what keeps this a one-listener event, proven by a test below.
 * - `beforeExit`: fires when the event loop has nothing left to do, which is not a shutdown signal
 *   this codebase has ever reacted to and would fire spuriously in-process under `node --test`.
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
 * The actual teardown, exported standalone so a test can drive it directly rather than through
 * `close-with-grace`'s real `process` signal handlers and its own `process.exit()` call at the end —
 * see `shutdown.test.ts`'s "ready → shutting down → closed" and in-flight-request coverage.
 *
 * Ordering matches the replaced library exactly: `SHUTTING_DOWN` fires first (so `stopping` is
 * logged when the teardown STARTS, not when it ends), then the pre-close delay, then `closeTasks` —
 * scheduler drain, collab socket close, db pool end — via `Promise.allSettled` (each is internally
 * bounded on its own, so one hanging task cannot hold up the others or the socket close that
 * follows), then `app.close()`, then `SHUTDOWN`.
 */
export async function runShutdownSequence(
  reason: ShutdownReason,
  // -> Narrower than `Pick<FastifyInstance, 'close'>`: Fastify types `close()` as returning
  //    `Promise<undefined>` specifically (its overload for a no-callback call), which a test's own
  //    `async () => {}` stand-in or `Promise<number>`-returning close spy would not satisfy. Any
  //    `close(): Promise<unknown>` — the real `FastifyInstance` included — satisfies this.
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
 * The two Fastify routes replacing the old library's own `livenessEndpoint`/`readinessEndpoint`
 * (which it served itself, straight off `app.server`, bypassing Fastify's router entirely). Ordinary
 * routes work just as well here: every leading-underscore path — `/_live`/`/_ready` included — is
 * already excluded from the SEO/site-resolution hooks by `siteRouting.ts#isPageUrl`, and the
 * auth/rate-limit hooks in `authHooks.ts` are scoped to `/_api/`-or-narrower paths, so neither needs
 * a bypass of the rest of the request pipeline.
 *
 * `/_live` answers 200 for as long as the process is up, independent of `isReady` — a liveness probe
 * asks only "is this process alive", never "is it ready for traffic". `/_ready` answers 200 only
 * once `isReady()` says so (flipped by `WIKI.server.setReady()` once `postBoot()` has populated the
 * caches every request path reads from — see `index.ts`) and 503 from the moment teardown starts.
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

/** What `WIKI.server` is typed as — see `types/global.d.ts`. */
export interface ShutdownController {
  on: EventEmitter['on']
  setReady: () => void
  isReady: () => boolean
  /** Removes every listener `close-with-grace` installed on `process` — test cleanup only; nothing
   * in production ever calls this, since the process is expected to exit right after `SHUTDOWN`. */
  uninstall: () => void
}

/**
 * Wires `close-with-grace` up to `runShutdownSequence` above and to a `FastifyInstance`'s own
 * `app.close()`. `delay: false` disables close-with-grace's own race-against-a-hard-timeout feature
 * (distinct from the pre-close delay above, which `runShutdownSequence` always runs): the replaced
 * library never imposed a second, independent kill timer either — each close task already bounds
 * itself (see `runShutdownSequence`'s doc comment) — and a caller wanting one can still send a
 * second signal, which close-with-grace's own `afterFirstSignal`/`afterFirstError` handlers still
 * answer with an immediate `process.exit(1)` regardless of this setting.
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
      // -> close-with-grace's own console-only diagnostics (a second signal/error while already
      //    closing) — routed through WIKI.logger like every other line rather than left on stdout
      //    as a second, differently-shaped producer.
      logger: {
        error: (message?: unknown, ...rest: unknown[]) =>
          WIKI.logger.warn('boot', [message, ...rest].filter(Boolean).join(' '))
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
