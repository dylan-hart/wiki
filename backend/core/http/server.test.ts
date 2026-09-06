import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { after, before, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import gracefulServer from '@gquittet/graceful-server'
import { createHttpApp, registerShutdownLogging, registerStaticAssets } from './server.ts'
import { createSilentLogger, installTestWiki } from '../../test/mocks.ts'

/**
 * The Fastify instance itself was built inline in `index.ts` until this split, which is why none of
 * it had a test: the only way to reach that code was to boot the whole process. `createHttpApp()`
 * makes the options block, the `@fastify/sensible` / `@fastify/compress` / `@fastify/websocket`
 * registrations and the graceful-shutdown wiring reachable without a listening socket — `inject()`
 * never binds one — so the settings that decide how every request is parsed and routed can be
 * asserted directly rather than inferred from an e2e failure.
 *
 * `registerStaticAssets()` is the other half: three mounts whose ORDER relative to
 * `registerSecurity`/`registerSession` is behaviour (Fastify registers plugins in call order), and
 * whose `/_assets/` mount carries the immutable-cache rule `helpers/common.ts#isHashedAssetFilename`
 * decides. Driven here against a throwaway `WIKI.ROOTPATH` laid out the way a built checkout is,
 * since `fastify-favicon` refuses to register at all without a real `assets/favicon.ico`.
 */

/** The minimum `WIKI` global `createHttpApp()` and `registerStaticAssets()` actually read. */
function installWikiStub({
  rootPath = process.cwd(),
  ...config
}: { rootPath?: string } & Record<string, any> = {}) {
  const previous = (globalThis as any).WIKI
  installTestWiki({
    INSTANCE_ID: 'test-instance',
    ROOTPATH: rootPath,
    sitesMappings: {},
    config: {
      bodyParserLimit: 0,
      logFormat: 'text',
      security: { trustProxy: false },
      ...config
    }
  })
  return () => {
    ;(globalThis as any).WIKI = previous
  }
}

describe('createHttpApp', () => {
  let restoreWiki: () => void
  let app: FastifyInstance

  before(async () => {
    restoreWiki = installWikiStub()
    app = createHttpApp()
    // -> Pino writes an access line per request to stdout; nothing here is asserting on logs, so
    //    silence the instance rather than interleaving them with the test runner's own output.
    app.log.level = 'silent'
    app.get('/echo', async (req, reply) => {
      // -> `reply.notFound` is @fastify/sensible's; reaching for it here is the assertion that the
      //    plugin registered, since every route in `api/` answers its errors through it.
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

  test('assigns WIKI.app and WIKI.server, so the boot script can listen and flip readiness', () => {
    assert.equal((globalThis as any).WIKI.app, app)
    assert.equal(typeof (globalThis as any).WIKI.server.setReady, 'function')
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
    // -> Pino writes an access line per request to stdout; nothing here is asserting on logs, so
    //    silence the instance rather than interleaving them with the test runner's own output.
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

describe('createHttpApp: logger shaping', () => {
  test('json log format binds the instance id, matching core/logger.ts JSON envelope', async () => {
    const restoreWiki = installWikiStub({ logFormat: 'json' })
    const app = createHttpApp()
    await app.ready()
    try {
      // -> `formatters.level` and `base` are the two options that decide the envelope, and both are
      //    only set on the json branch — so the presence of the `instance` binding is what
      //    distinguishes the two modes from outside.
      const bindings = (app.log as unknown as { bindings(): Record<string, unknown> }).bindings()
      assert.equal(bindings.instance, 'test-instance')
    } finally {
      await app.close()
      restoreWiki()
    }
  })

  test('text log format leaves pino at its Fastify default, with no instance binding', async () => {
    const restoreWiki = installWikiStub({ logFormat: 'text' })
    const app = createHttpApp()
    await app.ready()
    try {
      const bindings = (app.log as unknown as { bindings(): Record<string, unknown> }).bindings()
      assert.equal(bindings.instance, undefined)
    } finally {
      await app.close()
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
    fs.mkdirSync(path.join(rootPath, 'assets/_assets'), { recursive: true })
    fs.mkdirSync(path.join(rootPath, 'blocks/compiled'), { recursive: true })
    fs.writeFileSync(path.join(rootPath, 'assets/favicon.ico'), 'icon-bytes')
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/index-CL_uwIZr.js'), 'hashed')
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/renderer.js'), 'unhashed')
    fs.writeFileSync(path.join(rootPath, 'blocks/compiled/block-map.js'), 'block')

    restoreWiki = installWikiStub({ rootPath })
    app = createHttpApp()
    // -> Pino writes an access line per request to stdout; nothing here is asserting on logs, so
    //    silence the instance rather than interleaving them with the test runner's own output.
    app.log.level = 'silent'
    registerStaticAssets(app)
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
    fs.rmSync(rootPath, { recursive: true, force: true })
  })

  test('serves the root favicon', async () => {
    const res = await app.inject({ method: 'GET', url: '/favicon.ico' })
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

  test('serves a compiled block under /_blocks/', async () => {
    const res = await app.inject({ method: 'GET', url: '/_blocks/block-map.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=3600')
  })
})

describe('registerShutdownLogging', () => {
  /**
   * Drives the real event names against a bare `EventEmitter` — `IGracefulServer.on` is
   * `(name, callback) => EventEmitter`, so an emitter satisfies the parameter structurally and the
   * handler runs exactly as the library calls it, with no process signalling involved.
   */
  function emitShutdown(reason: Error) {
    const info = mock.fn()
    const warn = mock.fn()
    const wiki = installTestWiki({ logger: { ...createSilentLogger(), info, warn } })
    try {
      const server = new EventEmitter()
      registerShutdownLogging(server)
      server.emit(gracefulServer.SHUTDOWN, reason)
      return { info, warn }
    } finally {
      wiki.restore()
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    test(`${signal} is an ordinary shutdown: one info line, no warning and no stack`, () => {
      const { info, warn } = emitShutdown(new Error(signal))
      assert.equal(info.mock.callCount(), 1)
      assert.deepEqual(info.mock.calls[0].arguments, ['http', 'stopping', { reason: signal }])
      assert.equal(warn.mock.callCount(), 0)
    })
  }

  test('any other reason still warns with the error itself, stack included', () => {
    const boom = new Error('boom')
    const { info, warn } = emitShutdown(boom)
    assert.equal(info.mock.callCount(), 1)
    assert.equal(warn.mock.callCount(), 1)
    assert.equal(warn.mock.calls[0].arguments[0], 'http')
    // -> The `Error` itself under `fields.error`, so the renderer prints its message and its stack.
    assert.equal((warn.mock.calls[0].arguments[2] as { error: Error }).error, boom)
  })

  test('a message merely containing a signal name is not exempted', () => {
    // -> The reason is matched exactly, not by prefix or substring: graceful-server sets
    //    `new Error(<signal>)`, so a longer message is a real fault rather than a clean exit.
    const { warn } = emitShutdown(new Error('SIGTERM handler failed'))
    assert.equal(warn.mock.callCount(), 1)
  })

  test('the shutting-down event logs nothing of its own', () => {
    // -> One line per shutdown, on SHUTDOWN, where the reason is: the earlier SHUTTING_DOWN
    //    announcement carried no reason and preceded no work this handler does (OpenProject #2665).
    const info = mock.fn()
    const wiki = installTestWiki({ logger: { ...createSilentLogger(), info } })
    try {
      const server = new EventEmitter()
      registerShutdownLogging(server)
      server.emit(gracefulServer.SHUTTING_DOWN)
      assert.equal(info.mock.callCount(), 0)
    } finally {
      wiki.restore()
    }
  })
})
