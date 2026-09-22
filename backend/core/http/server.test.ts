import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { after, before, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import {
  createHttpApp,
  pinoStreamToWikiLogger,
  registerShutdownLogging,
  registerStaticAssets,
  ROOT_FAVICON_PATH,
  SERVICE_WORKER_PATH
} from './server.ts'
import { registerErrorHandler } from './errors.ts'
import { SHUTDOWN, SHUTTING_DOWN } from './shutdown.ts'
import { createSilentLogger, installTestWiki } from '../../test/mocks.ts'

function installWikiStub({
  rootPath = process.cwd(),
  serverPath = rootPath,
  logger,
  ...config
}: { rootPath?: string; serverPath?: string; logger?: any } & Record<string, any> = {}) {
  const previous = (globalThis as any).CARDINAL
  installTestWiki({
    INSTANCE_ID: 'test-instance',
    ROOTPATH: rootPath,
    SERVERPATH: serverPath,
    sitesMappings: {},
    ...(logger ? { logger } : {}),
    config: {
      bodyParserLimit: 0,
      logFormat: 'text',
      security: { trustProxy: false },
      ...config
    }
  })
  return () => {
    // -> `createHttpApp()` installs `close-with-grace`'s listeners on the real `process`. Without
    //    `uninstall()` they accumulate across this file's many apps, past Node's `MaxListeners`.
    ;(globalThis as any).CARDINAL?.server?.uninstall?.()
    ;(globalThis as any).CARDINAL = previous
  }
}

interface RecordedLine {
  level: 'error' | 'warn' | 'info' | 'debug'
  scope: unknown
  message: unknown
  fields: Record<string, unknown>
}

function createRecordingLogger(): { lines: RecordedLine[]; logger: any } {
  const lines: RecordedLine[] = []
  const at =
    (level: RecordedLine['level']) =>
    (scope: unknown, message?: unknown, fields?: Record<string, unknown>) => {
      lines.push({ level, scope, message, fields: fields ?? {} })
    }
  const logger: any = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') }
  logger.scope = () => logger
  return { lines, logger }
}

function httpLines(lines: RecordedLine[]): RecordedLine[] {
  return lines.filter((line) => line.scope === 'http')
}

describe('createHttpApp', () => {
  let restoreWiki: () => void
  let app: FastifyInstance

  before(async () => {
    restoreWiki = installWikiStub()
    app = createHttpApp()
    app.log.level = 'silent'
    app.get('/echo', async (req, reply) => {
      if ((req.query as { fail?: string }).fail) {
        return reply.notFound('nope')
      }
      return { ok: true }
    })
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
  })

  test('assigns CARDINAL.app and CARDINAL.server, so the boot script can listen and flip readiness', () => {
    assert.equal((globalThis as any).CARDINAL.app, app)
    assert.equal(typeof (globalThis as any).CARDINAL.server.setReady, 'function')
  })

  test('registers @fastify/sensible, so reply.notFound() is available to every route', async () => {
    const res = await app.inject({ method: 'GET', url: '/echo?fail=1' })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, 'nope')
  })

  test('ignores a trailing slash, so /page and /page/ are one route', async () => {
    const res = await app.inject({ method: 'GET', url: '/echo/' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
  })
})

describe("createHttpApp: the ajv 'hexcolor' format", () => {
  let restoreWiki: () => void
  let app: FastifyInstance

  before(async () => {
    restoreWiki = installWikiStub()
    app = createHttpApp()
    app.log.level = 'silent'
    app.post<{ Body: { color: string } }>(
      '/color',
      {
        schema: {
          body: {
            type: 'object',
            required: ['color'],
            properties: { color: { type: 'string', format: 'hexcolor' } }
          }
        }
      },
      async () => ({ ok: true })
    )
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
  })

  for (const color of ['#abc', '#abcd', '#aabbcc', '#aabbccdd']) {
    test(`accepts ${color}, one of the four forms a color picker produces`, async () => {
      const res = await app.inject({ method: 'POST', url: '/color', payload: { color } })
      assert.equal(res.statusCode, 200)
    })
  }

  test('refuses anything that is not one of those four forms', async () => {
    for (const color of ['rebeccapurple', '#ab', '#aabbc', 'aabbcc']) {
      const res = await app.inject({ method: 'POST', url: '/color', payload: { color } })
      assert.equal(res.statusCode, 400, `expected ${color} to be refused`)
    }
  })
})

/**
 * Each format is driven through a real route, so a value is accepted or refused by
 * `createHttpApp()`'s own registration rather than by a copy of its regex.
 */
const HAND_REGISTERED_FORMATS: Array<{ format: string; accept: string[]; reject: string[] }> = [
  {
    format: 'uuid',
    accept: [
      '123e4567-e89b-12d3-a456-426614174000',
      '123E4567-E89B-12D3-A456-426614174000',
      'urn:uuid:123e4567-e89b-12d3-a456-426614174000'
    ],
    reject: ['not-a-uuid', '123e4567-e89b-12d3-a456', '123e4567e89b12d3a456426614174000']
  },
  {
    format: 'hostname',
    accept: ['example.com', 'localhost', 'sub.example.co.uk', 'example.com.'],
    reject: ['exa mple.com', '-example.com', 'example..com', `${'a'.repeat(254)}.com`]
  },
  {
    format: 'email',
    accept: ['user@example.com', 'user.name+tag@sub.example.co'],
    reject: ['not-an-email', '@example.com', 'user@', 'user@@example.com']
  },
  {
    format: 'date-time',
    accept: ['2024-01-01T00:00:00Z', '2024-01-01t00:00:00.123+05:30', '2024-12-31T23:59:60z'],
    reject: ['2024-01-01', 'not-a-date', '2024-01-01T00:00:00', '2024-01-01T00:00:00X']
  }
]

for (const { format, accept, reject } of HAND_REGISTERED_FORMATS) {
  describe(`createHttpApp: the ajv '${format}' format`, () => {
    let restoreWiki: () => void
    let app: FastifyInstance

    before(async () => {
      restoreWiki = installWikiStub()
      app = createHttpApp()
      app.log.level = 'silent'
      app.post<{ Body: { value: string } }>(
        '/value',
        {
          schema: {
            body: {
              type: 'object',
              required: ['value'],
              properties: { value: { type: 'string', format } }
            }
          }
        },
        async () => ({ ok: true })
      )
      await app.ready()
    })

    after(async () => {
      await app.close()
      restoreWiki()
    })

    for (const value of accept) {
      test(`accepts ${JSON.stringify(value)}`, async () => {
        const res = await app.inject({ method: 'POST', url: '/value', payload: { value } })
        assert.equal(res.statusCode, 200, `expected ${JSON.stringify(value)} to be accepted`)
      })
    }

    test('refuses malformed values', async () => {
      for (const value of reject) {
        const res = await app.inject({ method: 'POST', url: '/value', payload: { value } })
        assert.equal(res.statusCode, 400, `expected ${JSON.stringify(value)} to be refused`)
      }
    })
  })
}

describe('createHttpApp: the http access line', () => {
  async function withApp(
    run: (app: FastifyInstance, lines: RecordedLine[]) => Promise<void>
  ): Promise<void> {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    // -> The real error handler, not a replica: the 500 case asserts that its line and the access
    //    line carry the same `reqId`.
    registerErrorHandler(app)
    app.get('/_api/ok', async () => ({ ok: true }))
    app.get('/_api/missing', async (_req, reply) => reply.notFound('nope'))
    app.get('/_api/boom', async () => {
      throw new Error('handler exploded')
    })
    await app.ready()
    try {
      await run(app, lines)
    } finally {
      await app.close()
      restoreWiki()
    }
  }

  test('a 200 emits exactly one debug http line, carrying reqId, ms and ip', async () => {
    await withApp(async (app, lines) => {
      const res = await app.inject({ method: 'GET', url: '/_api/ok' })
      assert.equal(res.statusCode, 200)

      const access = httpLines(lines)
      assert.equal(access.length, 1, 'one line per request, not pino’s incoming/completed pair')
      assert.equal(access[0].level, 'debug')
      assert.equal(access[0].message, 'GET /_api/ok → 200')
      assert.equal(typeof access[0].fields.reqId, 'string')
      assert.equal(typeof access[0].fields.ms, 'number', 'ms is a number, not a formatted string')
      assert.equal(typeof access[0].fields.ip, 'string')
    })
  })

  test('a 404 is a warn, so a refusal stays visible above the debug traffic', async () => {
    await withApp(async (app, lines) => {
      const res = await app.inject({ method: 'GET', url: '/_api/missing' })
      assert.equal(res.statusCode, 404)

      const access = httpLines(lines)
      assert.equal(access.length, 1)
      assert.equal(access[0].level, 'warn')
      assert.equal(access[0].message, 'GET /_api/missing → 404')
    })
  })

  test('a thrown handler emits the access line at error, sharing reqId with the 500', async () => {
    await withApp(async (app, lines) => {
      const res = await app.inject({ method: 'GET', url: '/_api/boom' })
      assert.equal(res.statusCode, 500)

      // -> Two `http` lines for one request: the access record, and the exception from
      //    `helpers/errorHandler.ts` on the same scope. `reqId` is what joins them.
      const http = httpLines(lines)
      assert.equal(http.length, 2)

      const access = http.filter((line) => line.message === 'GET /_api/boom → 500')
      assert.equal(
        access.length,
        1,
        'one access line per request, not pino’s incoming/completed pair'
      )
      assert.equal(access[0].level, 'error')

      const fromErrorHandler = http.find((line) => line.message === 'unhandled error, answered 500')
      assert.ok(fromErrorHandler, 'the error handler logged the exception itself')
      assert.ok(fromErrorHandler.fields.error instanceof Error)
      assert.equal(fromErrorHandler.fields.reqId, access[0].fields.reqId)
    })
  })

  test('carries the authenticated userId, and the site a site-scoped route resolved', async () => {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    app.get('/_api/sites/:siteId/thing', async (req) => {
      req.session = { authenticated: true, user: { id: 'user-9' } } as any
      return { ok: true }
    })
    await app.ready()
    try {
      await app.inject({ method: 'GET', url: '/_api/sites/site-7/thing' })
      const access = httpLines(lines)
      assert.equal(access.length, 1)
      assert.equal(access[0].fields.siteId, 'site-7')
      assert.equal(access[0].fields.userId, 'user-9')
    } finally {
      await app.close()
      restoreWiki()
    }
  })
})

describe('createHttpApp: pino no longer reaches stdout', () => {
  /**
   * Forwards what it captures, so the runner's own output survives. `CARDINAL.logger` prints to
   * stdout too, so the tests look for pino's `{"level":<n>` JSON prefix rather than for silence.
   */
  async function captureStdout(run: () => Promise<void>): Promise<string[]> {
    const captured: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: any, ...rest: any[]) => {
      captured.push(String(chunk))
      return (original as any)(chunk, ...rest)
    }
    try {
      await run()
    } finally {
      ;(process.stdout as any).write = original
    }
    return captured
  }

  const PINO_RECORD = /^\{"level":\d/

  test('a served request writes no pino record to stdout', async () => {
    const { logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    app.get('/echo', async () => ({ ok: true }))
    await app.ready()
    try {
      const captured = await captureStdout(async () => {
        await app.inject({ method: 'GET', url: '/echo' })
      })
      assert.ok(
        !captured.some((chunk) => PINO_RECORD.test(chunk)),
        `expected no pino record on stdout, saw: ${JSON.stringify(captured)}`
      )
    } finally {
      await app.close()
      restoreWiki()
    }
  })

  test("Fastify's own diagnostics are re-emitted as http lines instead of printed", async () => {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    await app.ready()
    try {
      const captured = await captureStdout(async () => {
        app.log.warn({ reqId: 'req-42' }, 'Reply was already sent')
        app.log.error({ err: new Error('boom') }, 'FST_ERR_SEND_INSIDE_ONERR')
      })

      assert.ok(!captured.some((chunk) => PINO_RECORD.test(chunk)))

      const [warned, errored] = httpLines(lines)
      assert.equal(warned.level, 'warn')
      assert.equal(warned.message, 'Reply was already sent')
      assert.equal(warned.fields.reqId, 'req-42')

      assert.equal(errored.level, 'error')
      assert.equal(errored.message, 'FST_ERR_SEND_INSIDE_ONERR')
      assert.ok(errored.fields.error instanceof Error)
      assert.equal((errored.fields.error as Error).message, 'boom')
    } finally {
      await app.close()
      restoreWiki()
    }
  })
})

describe('pinoStreamToWikiLogger', () => {
  test('drops a malformed record rather than throwing inside Fastify’s error path', () => {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    try {
      const stream = pinoStreamToWikiLogger()
      assert.doesNotThrow(() => stream.write('not json at all'))
      assert.doesNotThrow(() => stream.write('{"level":40}'))
      assert.equal(lines.length, 0, 'a record with no msg says nothing worth emitting')
    } finally {
      restoreWiki()
    }
  })
})

describe('registerStaticAssets', () => {
  let restoreWiki: () => void
  let app: FastifyInstance
  let rootPath: string

  before(async () => {
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-static-'))
    fs.mkdirSync(path.join(rootPath, path.dirname(ROOT_FAVICON_PATH)), { recursive: true })
    fs.mkdirSync(path.join(rootPath, 'assets/_assets'), { recursive: true })
    fs.mkdirSync(path.join(rootPath, 'blocks/compiled'), { recursive: true })
    fs.writeFileSync(path.join(rootPath, ROOT_FAVICON_PATH), 'icon-bytes')
    fs.writeFileSync(path.join(rootPath, SERVICE_WORKER_PATH), 'self.skipWaiting()')
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/index-CL_uwIZr.js'), 'hashed')
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/renderer.js'), 'unhashed')
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/logo-cardinal.svg'), 'logo')
    fs.mkdirSync(path.join(rootPath, 'assets/_assets/icons'), { recursive: true })
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/icons/color-document.svg'), 'icon')
    fs.mkdirSync(path.join(rootPath, 'assets/_assets/fonts'), { recursive: true })
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/fonts/index-CL_uwIZr.woff2'), 'font')
    fs.writeFileSync(path.join(rootPath, 'blocks/compiled/block-map.js'), 'block')

    // -> `ROOTPATH` and `SERVERPATH` share one synthetic tree: the repo-root vs. `backend/` split
    //    does not matter to a fixture that lays out one of each.
    restoreWiki = installWikiStub({ rootPath })
    app = createHttpApp()
    app.log.level = 'silent'
    registerStaticAssets(app)
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
    fs.rmSync(rootPath, { recursive: true, force: true })
  })

  test(
    'serves the root favicon read per request from backend/assets/branding/, with a revalidating ' +
      'Cache-Control and a strong ETag (OpenProject #2724 — no more buffering it once at boot)',
    async () => {
      const res = await app.inject({ method: 'GET', url: '/favicon.ico' })
      assert.equal(res.statusCode, 200)
      assert.equal(res.body, 'icon-bytes')
      assert.equal(res.headers['cache-control'], 'public, no-cache')
      assert.ok(res.headers.etag, 'expected an ETag on the favicon response')
      assert.equal(
        (res.headers.etag as string).startsWith('W/'),
        false,
        'expected a strong ETag, not a weak size/mtime one'
      )
    }
  )

  test('a matching If-None-Match against the root favicon short-circuits to an empty 304', async () => {
    const first = await app.inject({ method: 'GET', url: '/favicon.ico' })
    const etag = first.headers.etag as string

    const second = await app.inject({
      method: 'GET',
      url: '/favicon.ico',
      headers: { 'if-none-match': etag }
    })

    assert.equal(second.statusCode, 304)
    assert.equal(second.body, '')
  })

  test('serves /sw.js as JavaScript, revalidated every load, allowed to control the whole origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/sw.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'self.skipWaiting()')
    assert.match(res.headers['content-type'] as string, /^text\/javascript/)
    assert.equal(res.headers['cache-control'], 'no-cache')
    assert.equal(res.headers['service-worker-allowed'], '/')
  })

  test('answers /sw.js without resolving any site, so an unmapped hostname still gets a worker', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sw.js',
      headers: { host: 'unmapped.example.com' }
    })
    assert.equal(res.statusCode, 200)
  })

  test('serves a hashed build output under /_assets/ as immutable', async () => {
    const res = await app.inject({ method: 'GET', url: '/_assets/index-CL_uwIZr.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  })

  test('serves an unhashed /_assets/ entry on the plain 7d default instead', async () => {
    const res = await app.inject({ method: 'GET', url: '/_assets/renderer.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=604800')
  })

  for (const url of [
    '/_assets/logo-cardinal.svg',
    '/_assets/icons/color-document.svg',
    '/_assets/fonts/index-CL_uwIZr.woff2'
  ]) {
    test(`serves hand-authored ${url} on the plain 7d default, never immutable`, async () => {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['cache-control'], 'public, max-age=604800')
    })
  }

  test('serves a compiled block under /_blocks/', async () => {
    const res = await app.inject({ method: 'GET', url: '/_blocks/block-map.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=3600')
  })
})

/**
 * `frontend/public/favicon.ico` is a deliberate second copy of `ROOT_FAVICON_PATH`: the Vite dev
 * server answers `/favicon.ico` out of `public/` directly. `frontend/scripts/generate-favicon.mjs`
 * writes both from one render; this notices if they drift.
 */
describe('ROOT_FAVICON_PATH — the backend owns its own favicon.ico', () => {
  const serverPath = path.join(import.meta.dirname, '..', '..')

  test('resolves to a real file inside backend/', () => {
    const resolved = path.join(serverPath, ROOT_FAVICON_PATH)
    assert.equal(fs.statSync(resolved).isFile(), true, `${resolved} is not a file`)
  })

  test('is byte-identical to the frontend public copy the Vite dev server answers directly', () => {
    const backendCopy = fs.readFileSync(path.join(serverPath, ROOT_FAVICON_PATH))
    const frontendCopy = fs.readFileSync(
      path.join(serverPath, '..', 'frontend', 'public', 'favicon.ico')
    )
    assert.equal(
      backendCopy.equals(frontendCopy),
      true,
      'backend/assets/branding/favicon.ico and frontend/public/favicon.ico have drifted apart'
    )
  })
})

describe('SERVICE_WORKER_PATH — the committed worker', () => {
  const resolved = path.join(import.meta.dirname, '..', '..', SERVICE_WORKER_PATH)

  test('resolves to a real file inside backend/', () => {
    assert.equal(fs.statSync(resolved).isFile(), true, `${resolved} is not a file`)
  })

  test('caches nothing and deletes any cache entries when it activates', () => {
    const source = fs.readFileSync(resolved, 'utf8')
    assert.match(source, /caches\s*\.keys\(\)/)
    assert.match(source, /caches\.delete/)
    assert.equal(source.includes('cache.put'), false)
    assert.equal(source.includes('addAll'), false)
  })
})

describe('registerShutdownLogging', () => {
  /**
   * A bare `EventEmitter` satisfies `ShutdownController.on` structurally, so the handlers run as
   * `createGracefulShutdown` calls them with no process signalling. Emits both events, in
   * `runShutdownSequence`'s order; `startShutdown` stops after the first.
   */
  function emitShutdown(reason?: Error) {
    const { info, warn, server, restore } = startShutdown(reason)
    try {
      server.emit(SHUTDOWN, reason)
      return { info, warn }
    } finally {
      restore()
    }
  }

  function startShutdown(reason?: Error) {
    const info = mock.fn()
    const warn = mock.fn()
    const wiki = installTestWiki({ logger: { ...createSilentLogger(), info, warn } })
    const server = new EventEmitter()
    registerShutdownLogging(server)
    server.emit(SHUTTING_DOWN, reason)
    return { info, warn, server, restore: () => wiki.restore() }
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    test(`${signal} is an ordinary shutdown: stopping then stopped, no warning and no stack`, () => {
      const { info, warn } = emitShutdown(new Error(signal))
      assert.equal(info.mock.callCount(), 2)
      assert.deepEqual(info.mock.calls[0].arguments, ['boot', 'stopping', { reason: signal }])
      assert.equal(warn.mock.callCount(), 0)
    })
  }

  test('the stopped line carries `ms`, as a number, so the renderer prints it as a duration', () => {
    const { info } = emitShutdown(new Error('SIGTERM'))
    const [scope, message, fields] = info.mock.calls[1].arguments as [
      string,
      string,
      { ms: number }
    ]
    assert.equal(scope, 'boot')
    assert.equal(message, 'stopped')
    assert.equal(typeof fields.ms, 'number')
    assert.ok(fields.ms >= 0)
  })

  test('stopping is emitted when the teardown starts, not when it ends', () => {
    // -> `runShutdownSequence` runs its pre-close delay, the close tasks and the socket close
    //    BETWEEN the two events, so a `stopping` logged on SHUTDOWN would follow the teardown it
    //    announces and `ms` would measure nothing.
    const { info, server, restore } = startShutdown(new Error('SIGTERM'))
    try {
      assert.equal(info.mock.callCount(), 1)
      assert.deepEqual(info.mock.calls[0].arguments, ['boot', 'stopping', { reason: 'SIGTERM' }])
      server.emit(SHUTDOWN, new Error('SIGTERM'))
      assert.equal(info.mock.callCount(), 2)
      assert.equal(info.mock.calls[1].arguments[1], 'stopped')
    } finally {
      restore()
    }
  })

  test('any other reason still warns with the error itself, stack included', () => {
    const boom = new Error('boom')
    const { info, warn } = emitShutdown(boom)
    assert.equal(info.mock.callCount(), 2)
    assert.equal(warn.mock.callCount(), 1)
    assert.equal(warn.mock.calls[0].arguments[0], 'boot')
    assert.equal((warn.mock.calls[0].arguments[2] as { error: Error }).error, boom)
  })

  test('a message merely containing a signal name is not exempted', () => {
    // -> `runShutdownSequence` sets exactly `new Error(<signal>)`, so a longer message is a real
    //    fault rather than a clean exit.
    const { warn } = emitShutdown(new Error('SIGTERM handler failed'))
    assert.equal(warn.mock.callCount(), 1)
  })

  test('a programmatic stop, which carries no Error at all, is reported but not warned about', () => {
    // -> `close-with-grace`'s manual `close()` carries neither a `signal` nor an `err`, so
    //    `runShutdownSequence` emits both events with `undefined`.
    const { info, warn } = emitShutdown(undefined)
    assert.deepEqual(info.mock.calls[0].arguments, ['boot', 'stopping', { reason: 'programmatic' }])
    assert.equal(warn.mock.callCount(), 0)
  })
})
