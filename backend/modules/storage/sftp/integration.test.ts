import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { connectSftp, ensureDirectory, type SftpTargetConfig } from './connection.ts'
import { exportAssets, type AssetExportRow } from './assets.ts'
import { exportPages, type PageExportRow } from './pages.ts'
import { exportAll } from './storage.ts'
import { generateTestKeyPair, startTestSftpServer } from '../../../test/sftpServer.ts'
import type { TestSftpServer } from '../../../test/sftpServer.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { ensureTemporal } from '../../../test/temporal.ts'

/**
 * Integration coverage for the `sftp` storage module, against a real (if narrow) SFTP server rather
 * than a stub of `ssh2-sftp-client`'s API — see `test/sftpServer.ts` for why that's built directly on
 * `ssh2` instead of a stub or a Docker fixture. Everything below runs a real TCP connection to
 * `127.0.0.1` and reads back real files from a real (temporary) directory on disk; the only thing
 * replaced is the database query each of `exportPages`/`exportAssets` would otherwise run
 * (`fetchBatch`), following the same dependency-injection convention their own unit tests already use
 * — this is exactly the "not SQL orchestration" case CLAUDE.md's testing conventions say to stub
 * rather than reaching for a live Postgres for.
 *
 * `injectFrontMatter` (via `exportPages`) converts a page's `createdAt`/`updatedAt` through
 * `Date#toTemporalInstant()`, a Node 26 global this sandbox's Node v25.9.0 doesn't provide — same gap
 * `helpers/pageSerialization.test.ts` and `core/scheduler.test.ts` already work around.
 */
let wikiHandle: { restore(): void }
let loggerCalls: { level: string; scope: string; message: string }[]

before(async () => {
  await ensureTemporal()
})

beforeEach(() => {
  loggerCalls = []
  wikiHandle = installTestWiki({
    // -> Not the silent default: several tests assert on what the export run logged. `scope()` has to
    //    be a real child here rather than `createSilentLogger`'s `() => stub`, since the module logs
    //    only through one.
    logger: (() => {
      const at = (level: string, scope: string) => (message: string) => {
        loggerCalls.push({ level, scope, message })
      }
      const scope = (name: string) => ({
        info: mock.fn(at('info', name)),
        warn: mock.fn(at('warn', name)),
        error: mock.fn(),
        debug: mock.fn(),
        scope
      })
      return {
        info: mock.fn(at('info', '')),
        warn: mock.fn(at('warn', '')),
        error: mock.fn(),
        debug: mock.fn(),
        scope
      }
    })()
  })
})

afterEach(() => {
  wikiHandle.restore()
})

const PASSWORD_USER = { username: 'pwuser', password: 'hunter2-test' }
const keyPairPlain = generateTestKeyPair()
const KEY_USER_PLAIN = { username: 'keyuser-plain', publicKey: keyPairPlain.publicKey }
const keyPairPassphrase = generateTestKeyPair('s3cr3t-passphrase')
const KEY_USER_PASSPHRASE = {
  username: 'keyuser-passphrase',
  publicKey: keyPairPassphrase.publicKey
}

let server: TestSftpServer

before(async () => {
  server = await startTestSftpServer([PASSWORD_USER, KEY_USER_PLAIN, KEY_USER_PASSPHRASE])
})

after(async () => {
  await server.stop()
})

/** Create a fresh, empty directory directly under the server's backing root, and return the absolute
 *  SFTP-side path to it — what a target's `basePath` would point at. */
function makeBaseDir(name: string): string {
  fs.mkdirSync(path.join(server.rootDir, name))
  return `/${name}`
}

function makeConfig(overrides: Partial<SftpTargetConfig> = {}): SftpTargetConfig {
  return {
    host: '127.0.0.1',
    port: server.port,
    username: PASSWORD_USER.username,
    authMode: 'password',
    password: PASSWORD_USER.password,
    basePath: makeBaseDir(`base-${Math.random().toString(36).slice(2)}`),
    ...overrides
  }
}

describe('connectSftp — real server auth', () => {
  test('connects with password auth', async () => {
    const client = await connectSftp(makeConfig())
    await client.end()
  })

  test('rejects a wrong password with a clear error', async () => {
    await assert.rejects(
      connectSftp(makeConfig({ password: 'not-the-right-password' })),
      /Could not connect to 127\.0\.0\.1/
    )
  })

  test('connects with private-key auth and no passphrase', async () => {
    const client = await connectSftp(
      makeConfig({
        username: KEY_USER_PLAIN.username,
        authMode: 'privateKey',
        password: undefined,
        privateKey: keyPairPlain.privateKey
      })
    )
    await client.end()
  })

  test('connects with private-key auth protected by a passphrase', async () => {
    const client = await connectSftp(
      makeConfig({
        username: KEY_USER_PASSPHRASE.username,
        authMode: 'privateKey',
        password: undefined,
        privateKey: keyPairPassphrase.privateKey,
        passphrase: 's3cr3t-passphrase'
      })
    )
    await client.end()
  })

  test('rejects private-key auth with the wrong passphrase', async () => {
    await assert.rejects(
      connectSftp(
        makeConfig({
          username: KEY_USER_PASSPHRASE.username,
          authMode: 'privateKey',
          password: undefined,
          privateKey: keyPairPassphrase.privateKey,
          passphrase: 'wrong-passphrase'
        })
      )
    )
  })
})

describe('ensureDirectory — real server', () => {
  test('creates a nested directory tree that did not exist', async () => {
    const config = makeConfig()
    const client = await connectSftp(config)
    try {
      await ensureDirectory(client, config.basePath, 'en/guides/setup')
    } finally {
      await client.end()
    }

    const baseName = config.basePath.slice(1)
    for (const dir of ['en', 'en/guides', 'en/guides/setup']) {
      const real = path.join(server.rootDir, baseName, dir)
      assert.ok(fs.existsSync(real), `expected ${real} to exist`)
      assert.ok(fs.statSync(real).isDirectory())
    }
  })

  test('is a no-op the second time the same tree is ensured', async () => {
    const config = makeConfig()
    const client = await connectSftp(config)
    try {
      await ensureDirectory(client, config.basePath, 'a/b')
      await assert.doesNotReject(ensureDirectory(client, config.basePath, 'a/b'))
    } finally {
      await client.end()
    }
  })
})

describe('exportAll — full run against a seeded site (real server)', () => {
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
      config: makeConfig(),
      ...overrides
    })
  }

  test('writes every seeded page and asset to the expected remote paths', async () => {
    const target = makeTarget()

    const pageFixtures: PageExportRow[] = [
      {
        id: 'page-1',
        locale: 'en',
        path: 'welcome',
        contentType: 'markdown',
        content: '# Hello\n\nWelcome to the wiki.\n',
        title: 'Welcome',
        description: 'The landing page',
        tags: ['intro'],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z')
      },
      {
        id: 'page-2',
        locale: 'fr',
        path: 'welcome',
        contentType: 'markdown',
        content: '# Bonjour\n\nBienvenue sur le wiki.\n',
        title: 'Bienvenue',
        description: null,
        tags: null,
        createdAt: new Date('2026-01-03T00:00:00Z'),
        updatedAt: null
      }
    ]

    const assetFixtures: AssetExportRow[] = [
      {
        id: 'asset-1',
        fileName: 'logo.png',
        folderPath: '',
        kind: 'image',
        fileSize: 4,
        data: Buffer.from('PNG-bytes')
      },
      {
        id: 'asset-2',
        fileName: 'photo.jpg',
        folderPath: 'images/nested',
        kind: 'image',
        fileSize: 4,
        data: Buffer.from('JPG-bytes')
      }
    ]

    await exportAll(target, {
      runExportPages: (client, t, options) =>
        exportPages(client, t, {
          ...options,
          localeInfo: { defaultLocale: 'en', namespacingEnabled: true },
          fetchBatch: async ({ afterId }) => (afterId ? [] : pageFixtures)
        }),
      runExportAssets: (client, t, options) =>
        exportAssets(client, t, {
          ...options,
          fetchBatch: async ({ afterId }) => (afterId ? [] : assetFixtures)
        })
    })

    const baseName = target.config.basePath.slice(1)
    const prefix = `${baseName}/`
    const written = server
      .listFiles()
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length))
      .sort()

    assert.deepEqual(written, [
      'fr/welcome.md',
      'images/nested/photo.jpg',
      'logo.png',
      'welcome.md'
    ])

    // -> The default locale (`en`) is never namespaced; a non-default locale (`fr`) is.
    const enBody = fs.readFileSync(path.join(server.rootDir, baseName, 'welcome.md'), 'utf8')
    assert.match(enBody, /title: Welcome/)
    assert.match(enBody, /description: The landing page/)
    assert.match(enBody, /# Hello/)
    assert.match(enBody, /Welcome to the wiki\./)

    const frBody = fs.readFileSync(path.join(server.rootDir, baseName, 'fr/welcome.md'), 'utf8')
    assert.match(frBody, /title: Bienvenue/)
    assert.match(frBody, /# Bonjour/)

    // -> Assets are written as raw bytes, not text — a folderPath nests them exactly where the tree
    //    table said they lived.
    assert.deepEqual(
      fs.readFileSync(path.join(server.rootDir, baseName, 'logo.png')),
      Buffer.from('PNG-bytes')
    )
    assert.deepEqual(
      fs.readFileSync(path.join(server.rootDir, baseName, 'images/nested/photo.jpg')),
      Buffer.from('JPG-bytes')
    )

    // -> `exportAll`'s own orchestration/logging ran too, over the real connection.
    assert.ok(loggerCalls.some((c) => c.scope === 'storage' && c.message === 'starting the export'))
    assert.ok(loggerCalls.some((c) => c.scope === 'storage' && c.message === 'export completed'))
  })
})
