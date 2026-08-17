import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { after, before, beforeEach, describe, test } from 'node:test'
import type Client from 'ssh2-sftp-client'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * `exportAll` is what `models/storage.ts`'s `executeAction` calls (`mod[handler](target)`), so the
 * production entry point takes only `target`. Every collaborator it calls — `connectSftp`,
 * `exportPages`, `exportAssets` — is swappable through an optional second `deps` argument that
 * `executeAction` never supplies, which is what lets this suite verify the orchestration (call order,
 * logging, and that the connection always closes) without a real SFTP server or database.
 */

let previousWiki: any
let loggerCalls: { level: string; message: string }[]

before(() => {
  previousWiki = (globalThis as any).WIKI
})

beforeEach(() => {
  loggerCalls = []
  ;(globalThis as any).WIKI = {
    logger: {
      info: mock.fn((message: string) => loggerCalls.push({ level: 'info', message })),
      warn: mock.fn((message: string) => loggerCalls.push({ level: 'warn', message })),
      error: mock.fn((message: string) => loggerCalls.push({ level: 'error', message })),
      debug: mock.fn((message: string) => loggerCalls.push({ level: 'debug', message }))
    }
  }
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return {
    id: 'target-1',
    siteId: 'site-1',
    module: 'sftp',
    isEnabled: true,
    title: 'SFTP',
    description: '',
    icon: '',
    banner: '',
    vendor: '',
    website: '',
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
    versioning: { isSupported: false, isForceEnabled: false, enabled: false },
    props: {},
    config: { host: 'files.example.com', port: 22, username: 'wiki', basePath: '/srv/wiki' },
    actions: [],
    ...overrides
  }
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

    const infoMessages = loggerCalls.filter((c) => c.level === 'info').map((c) => c.message)
    // -> Logged once per batch (per call to onProgress), never once per item — the whole point of the
    //    callback existing is to keep a large export's log output bounded.
    assert.ok(infoMessages.some((m) => m.includes('200 pages')))
    assert.ok(infoMessages.some((m) => m.includes('340 pages')))
    assert.ok(infoMessages.some((m) => m.includes('50 assets')))
    // -> A start line and a completion line frame the batch progress, so an admin reading the log can
    //    tell an export ran to completion rather than stalled partway.
    assert.ok(infoMessages.some((m) => m.includes('Starting export')))
    assert.ok(infoMessages.some((m) => m.includes('completed successfully')))
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

    const warnMessages = loggerCalls.filter((c) => c.level === 'warn').map((c) => c.message)
    assert.ok(warnMessages.some((m) => m.includes('socket already closed')))
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

    const warnMessages = loggerCalls.filter((c) => c.level === 'warn').map((c) => c.message)
    assert.ok(warnMessages.some((m) => m.includes('connection reset')))
  })
})
