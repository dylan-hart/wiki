import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { afterEach, beforeEach, describe, test } from 'node:test'
import type Client from 'ssh2-sftp-client'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * `exportAll` is what `models/storage.ts`'s `executeAction` calls (`mod[handler](target)`), so the
 * production entry point takes only `target`. Every collaborator it calls — `connectSftp`,
 * `exportPages`, `exportAssets` — is swappable through an optional second `deps` argument that
 * `executeAction` never supplies, which is what lets this suite verify the orchestration (call order,
 * logging, and that the connection always closes) without a real SFTP server or database.
 */

let wikiHandle: { restore(): void }
let loggerCalls: {
  level: string
  scope: string
  message: string
  fields: Record<string, unknown>
}[]

/**
 * A `logger.scope()` child that records what it was handed, rather than `createSilentLogger`'s own
 * `scope: () => stub` — this module logs exclusively through a child, so a stub that collapsed the
 * child back onto the parent would lose both the scope and the standing fields the real one merges.
 */
function recordingLogger(): Record<string, unknown> {
  const at =
    (level: string, scope: string, bound: Record<string, unknown>) =>
    (message: string, fields: Record<string, unknown> = {}) => {
      loggerCalls.push({ level, scope, message, fields: { ...bound, ...fields } })
    }
  const scope = (name: string, bound: Record<string, unknown> = {}) => ({
    info: mock.fn(at('info', name, bound)),
    warn: mock.fn(at('warn', name, bound)),
    error: mock.fn(at('error', name, bound)),
    debug: mock.fn(at('debug', name, bound)),
    scope
  })
  return {
    info: mock.fn(at('info', '', {})),
    warn: mock.fn(at('warn', '', {})),
    error: mock.fn(at('error', '', {})),
    debug: mock.fn(at('debug', '', {})),
    scope
  }
}

beforeEach(() => {
  loggerCalls = []
  wikiHandle = installTestWiki({
    // -> Not the silent default: several tests assert on WHAT was logged and at which level.
    logger: recordingLogger()
  })
})

afterEach(() => {
  wikiHandle.restore()
})

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return makeStorageTarget('sftp', {
    id: 'target-1',
    title: 'SFTP',
    contentTypes: {
      activeTypes: ['pages', 'images', 'documents', 'others', 'large'],
      largeThreshold: '5MB'
    },
    assetDelivery: {
      isStreamingSupported: false,
      isDirectAccessSupported: false,
      streaming: false,
      directAccess: false
    },
    sync: {
      supportedModes: ['push'],
      schedule: false,
      mode: 'push',
      scheduleOverride: null,
      supportsContentSync: false
    },
    config: { host: 'files.example.com', port: 22, username: 'wiki', basePath: '/srv/wiki' },
    ...overrides
  })
}

function makeStubClient(overrides: Record<string, any> = {}): any {
  return {
    end: mock.fn(async () => undefined),
    ...overrides
  }
}

describe('exportAll', () => {
  test('connects, exports pages then assets in sequence, and closes the connection', async () => {
    const { exportAll } = await import('./storage.ts')
    const target = makeTarget()
    const client = makeStubClient()
    const callOrder: string[] = []

    const connect = mock.fn(async (config: any) => {
      callOrder.push('connect')
      assert.equal(config, target.config)
      return client as unknown as Client
    })
    const runExportPages = mock.fn(async (c: any, t: any) => {
      callOrder.push('exportPages')
      assert.equal(c, client)
      assert.equal(t, target)
    })
    const runExportAssets = mock.fn(async (c: any, t: any) => {
      callOrder.push('exportAssets')
      assert.equal(c, client)
      assert.equal(t, target)
    })

    await exportAll(target, { connect, runExportPages, runExportAssets })

    assert.deepEqual(callOrder, ['connect', 'exportPages', 'exportAssets'])
    assert.equal(client.end.mock.calls.length, 1)
  })

  test('passes an onProgress callback to exportPages and exportAssets that logs per-batch progress', async () => {
    const { exportAll } = await import('./storage.ts')
    const target = makeTarget()
    const client = makeStubClient()

    const connect = mock.fn(async () => client as unknown as Client)
    const runExportPages = mock.fn(async (_c: any, _t: any, options: any) => {
      options.onProgress(200)
      options.onProgress(340)
    })
    const runExportAssets = mock.fn(async (_c: any, _t: any, options: any) => {
      options.onProgress(50)
    })

    await exportAll(target, { connect, runExportPages, runExportAssets })

    // -> Logged once per batch (per call to onProgress), never once per item — the whole point of the
    //    callback existing is to keep a large export's log output bounded. Progress is `debug`: it is
    //    per-tick detail, and only the two framing lines belong in an `info` operator's record.
    const progress = loggerCalls.filter((c) => c.level === 'debug')
    assert.deepEqual(
      progress.map((c) => c.message),
      ['exporting pages', 'exporting pages', 'exporting assets']
    )
    assert.deepEqual(
      progress.map((c) => c.fields.pages ?? c.fields.assets),
      [200, 340, 50]
    )
    // -> A start line and a completion line frame the batch progress, so an admin reading the log can
    //    tell an export ran to completion rather than stalled partway.
    const infoMessages = loggerCalls.filter((c) => c.level === 'info').map((c) => c.message)
    assert.deepEqual(infoMessages, ['starting the export', 'export completed'])
    // -> Every line carries the scope and the two standing fields, so a line says which target it is
    //    about without the message spelling it out.
    assert.ok(
      loggerCalls.every(
        (c) => c.scope === 'storage' && c.fields.module === 'sftp' && c.fields.target === target.id
      )
    )
  })

  test('still closes the connection when exportPages throws, and rethrows the original error', async () => {
    const { exportAll } = await import('./storage.ts')
    const target = makeTarget()
    const client = makeStubClient()

    const connect = mock.fn(async () => client as unknown as Client)
    const runExportPages = mock.fn(async () => {
      throw new Error('disk full on remote host')
    })
    const runExportAssets = mock.fn(async () => {})

    await assert.rejects(
      exportAll(target, { connect, runExportPages, runExportAssets }),
      /disk full on remote host/
    )

    assert.equal(client.end.mock.calls.length, 1)
    // -> exportAssets never runs once exportPages has thrown
    assert.equal(runExportAssets.mock.calls.length, 0)
  })

  test('still closes the connection when exportAssets throws, and rethrows the original error', async () => {
    const { exportAll } = await import('./storage.ts')
    const target = makeTarget()
    const client = makeStubClient()

    const connect = mock.fn(async () => client as unknown as Client)
    const runExportPages = mock.fn(async () => {})
    const runExportAssets = mock.fn(async () => {
      throw new Error('permission denied writing asset')
    })

    await assert.rejects(
      exportAll(target, { connect, runExportPages, runExportAssets }),
      /permission denied writing asset/
    )

    assert.equal(client.end.mock.calls.length, 1)
  })

  test('propagates a connection failure without attempting to close a client that was never opened', async () => {
    const { exportAll } = await import('./storage.ts')
    const target = makeTarget()

    const connect = mock.fn(async () => {
      throw new Error('Could not connect to files.example.com:22 over SFTP as "wiki": timeout')
    })
    const runExportPages = mock.fn(async () => {})
    const runExportAssets = mock.fn(async () => {})

    await assert.rejects(
      exportAll(target, { connect, runExportPages, runExportAssets }),
      /Could not connect to files\.example\.com/
    )

    assert.equal(runExportPages.mock.calls.length, 0)
    assert.equal(runExportAssets.mock.calls.length, 0)
  })

  test('a failure closing the connection is logged but does not mask the real export error', async () => {
    const { exportAll } = await import('./storage.ts')
    const target = makeTarget()
    const client = makeStubClient({
      end: mock.fn(async () => {
        throw new Error('socket already closed')
      })
    })

    const connect = mock.fn(async () => client as unknown as Client)
    const runExportPages = mock.fn(async () => {
      throw new Error('the real export error')
    })
    const runExportAssets = mock.fn(async () => {})

    await assert.rejects(
      exportAll(target, { connect, runExportPages, runExportAssets }),
      /the real export error/
    )

    const warnings = loggerCalls.filter((c) => c.level === 'warn')
    assert.ok(
      warnings.some(
        (c) =>
          c.message === 'could not cleanly close the SFTP connection' &&
          (c.fields.error as Error).message === 'socket already closed'
      )
    )
  })

  test('a failure closing the connection after a successful export is logged, not thrown', async () => {
    const { exportAll } = await import('./storage.ts')
    const target = makeTarget()
    const client = makeStubClient({
      end: mock.fn(async () => {
        throw new Error('connection reset')
      })
    })

    const connect = mock.fn(async () => client as unknown as Client)
    const runExportPages = mock.fn(async () => {})
    const runExportAssets = mock.fn(async () => {})

    // -> Does not reject: a close failure after a clean export is a warning, not a thrown error
    await exportAll(target, { connect, runExportPages, runExportAssets })

    const warnings = loggerCalls.filter((c) => c.level === 'warn')
    assert.ok(
      warnings.some(
        (c) =>
          c.message === 'could not cleanly close the SFTP connection' &&
          (c.fields.error as Error).message === 'connection reset'
      )
    )
  })
})
