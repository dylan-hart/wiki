import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { load } from 'js-yaml'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import configSvc, { CONFIG_OVERRIDE_VARS } from './config.ts'
import { AdvisoryLockAcquisitionError } from '../helpers/advisoryLock.ts'
import { resolvePoolSizeOptions } from './db.ts'
import { relations } from '../db/relations.ts'
import { groups as groupsTable, sites as sitesTable } from '../db/schema.ts'
import { createExtensionsSerialized, hasTestDatabase } from '../test/db.ts'
import {
  createCacheStub,
  createEventsStub,
  createSchedulerStub,
  createSilentLogger,
  installTestWiki
} from '../test/mocks.ts'
import { ensureTemporal } from '../test/temporal.ts'
import type { WikiDb } from './db.ts'

// The DB-backed suites seed through `models/jobs.ts#init()`, which calls `Temporal.Now.instant()`.
await ensureTemporal()

let dir: string
let dbPassFile: string
let wikiHandle: { restore(): void }
let previousDbPassFile: string | undefined
let previousExit: typeof process.exit

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-config-test-'))

  await writeFile(
    path.join(dir, 'base.yml'),
    'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n'
  )
  await writeFile(path.join(dir, 'config.yml'), 'port: 3000\n')
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
  )

  // Trailing newline, as a real Docker secret file (or `echo pass > file`) would produce — this is
  // what proves the read is trimmed.
  dbPassFile = path.join(dir, 'db-pass.txt')
  await writeFile(dbPassFile, 'sup3rSecret\n')

  wikiHandle = installTestWiki({ ROOTPATH: dir, SERVERPATH: dir, logger: { warn: mock.fn() } })

  previousDbPassFile = process.env.DB_PASS_FILE
  process.env.DB_PASS_FILE = dbPassFile

  // `init()`'s catch block calls process.exit(1) — throw instead, so a failure surfaces rather than
  // killing the test runner.
  previousExit = process.exit
  ;(process as any).exit = (code?: number) => {
    throw new Error(`process.exit(${code}) called — DB_PASS_FILE read/trim threw`)
  }
})

after(async () => {
  wikiHandle.restore()
  process.exit = previousExit
  if (previousDbPassFile === undefined) {
    delete process.env.DB_PASS_FILE
  } else {
    process.env.DB_PASS_FILE = previousDbPassFile
  }
  await rm(dir, { recursive: true, force: true })
})

test('reads and trims the DB_PASS_FILE contents into CARDINAL.config.db.pass', async () => {
  await configSvc.init(true)

  const wiki = (globalThis as any).CARDINAL
  assert.equal(wiki.config.db.pass, 'sup3rSecret')
})

describe('pool.max reaches the Pool() options in db.ts', () => {
  test('the real backend/base.yml declares an explicit pool.max, not the node-postgres default of 10', async () => {
    const realBaseYmlPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'base.yml'
    )
    const parsed = load(await readFile(realBaseYmlPath, 'utf8')) as any
    const realPool = parsed.defaults.config.pool

    assert.equal(typeof realPool.max, 'number')
    assert.ok(
      realPool.max > 10,
      `expected base.yml's pool.max to explicitly override the pg default of 10, got ${realPool.max}`
    )
  })

  let poolDir: string
  let previousPoolWiki: any

  before(async () => {
    poolDir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-config-pool-test-'))
    await writeFile(
      path.join(poolDir, 'base.yml'),
      'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n    pool:\n      min: 1\n      max: 33\n'
    )
    await writeFile(path.join(poolDir, 'config.yml'), 'port: 3000\n')
    await writeFile(
      path.join(poolDir, 'package.json'),
      JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
    )

    previousPoolWiki = (globalThis as any).CARDINAL
    wikiHandle = installTestWiki({ ROOTPATH: poolDir, SERVERPATH: poolDir })
  })

  after(async () => {
    ;(globalThis as any).CARDINAL = previousPoolWiki
    await rm(poolDir, { recursive: true, force: true })
  })

  test('a configured pool.max flows through CARDINAL.config.pool into the Pool() constructor options', async () => {
    await configSvc.init(true)

    const wiki = (globalThis as any).CARDINAL
    assert.deepEqual(wiki.config.pool, { min: 1, max: 33 })

    // -> The exact call db.ts's `init()` spreads into `new Pool()` — proving the configured value
    //    reaches that constructor, not just CARDINAL.config.
    assert.deepEqual(resolvePoolSizeOptions(false, wiki.config.pool), { min: 1, max: 33 })

    // -> Worker mode ignores the configured value entirely and pins to a single connection.
    assert.deepEqual(resolvePoolSizeOptions(true, wiki.config.pool), { min: 0, max: 1 })
  })
})

{
  const baseYml =
    'defaults:\n  config:\n    port: 80\n    logLevel: info\n    db:\n      host: localhost\n      pass: basedefaultpass\n      sslOptions:\n        auto: true\n'

  async function setupFixture(configYml: string) {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-config-unknown-keys-test-'))
    await writeFile(path.join(fixtureDir, 'base.yml'), baseYml)
    await writeFile(path.join(fixtureDir, 'config.yml'), configYml)
    await writeFile(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
    )
    return fixtureDir
  }

  test('warns once per unknown config.yml key, at any depth', async () => {
    const fixtureDir = await setupFixture(
      'port: 3000\nlogLvel: debug\ndb:\n  host: myhost\n  sslOptions:\n    autoo: false\n'
    )
    // -> `console.warn`, not `CARDINAL.logger.warn`: `init()` runs before `CARDINAL.logger` exists
    //    at every real call site.
    const previous = (globalThis as any).CARDINAL
    wikiHandle = installTestWiki({ ROOTPATH: fixtureDir, SERVERPATH: fixtureDir })
    const warn = mock.method(console, 'warn', () => {})

    try {
      await configSvc.init(true)
    } finally {
      warn.mock.restore()
      ;(globalThis as any).CARDINAL = previous
      await rm(fixtureDir, { recursive: true, force: true })
    }

    assert.equal(warn.mock.callCount(), 2)
    const messages = warn.mock.calls.map((call) => call.arguments[0])
    assert.ok(messages.some((m: string) => m.includes('logLvel')))
    assert.ok(messages.some((m: string) => m.includes('db.sslOptions.autoo')))
  })

  test('does not warn for a fully-valid config.yml', async () => {
    const fixtureDir = await setupFixture(
      'port: 3000\nlogLevel: debug\ndb:\n  host: myhost\n  sslOptions:\n    auto: false\n'
    )
    const previous = (globalThis as any).CARDINAL
    wikiHandle = installTestWiki({ ROOTPATH: fixtureDir, SERVERPATH: fixtureDir })
    const warn = mock.method(console, 'warn', () => {})

    try {
      await configSvc.init(true)
    } finally {
      warn.mock.restore()
      ;(globalThis as any).CARDINAL = previous
      await rm(fixtureDir, { recursive: true, force: true })
    }

    assert.equal(warn.mock.callCount(), 0)
  })
}

describe('init() config provenance', () => {
  const OVERRIDE_VARS = ['CONFIG_FILE', 'PORT', 'WIKI_PORT', 'DB_PASS_FILE'] as const

  let fixtureDir: string
  let saved: Partial<Record<(typeof OVERRIDE_VARS)[number], string | undefined>>

  before(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), 'wikijs-config-provenance-test-'))
    await writeFile(
      path.join(fixtureDir, 'base.yml'),
      'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n'
    )
    await writeFile(path.join(fixtureDir, 'config.yml'), 'port: 3000\n')
    await writeFile(path.join(fixtureDir, 'alt.yml'), 'port: 4000\n')
    await writeFile(path.join(fixtureDir, 'no-port.yml'), 'port: 0\n')
    await writeFile(path.join(fixtureDir, 'secret.txt'), 'sup3rSecret\n')
    await writeFile(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
    )
  })

  after(async () => {
    await rm(fixtureDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    // -> The file-level `before()` exports DB_PASS_FILE for the whole run, so each of these starts
    //    from a known-empty environment rather than inheriting it.
    saved = {}
    for (const name of OVERRIDE_VARS) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const name of OVERRIDE_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = saved[name]
      }
    }
  })

  async function initInFixture() {
    const previous = (globalThis as any).CARDINAL
    installTestWiki({ ROOTPATH: fixtureDir, SERVERPATH: fixtureDir })
    try {
      return await configSvc.init(true)
    } finally {
      ;(globalThis as any).CARDINAL = previous
    }
  }

  test('reports the resolved config path and no overrides when the environment sets none', async () => {
    const { configPath, overrides } = await initInFixture()
    assert.equal(configPath, path.join(fixtureDir, 'config.yml'))
    assert.deepEqual(overrides, [])
  })

  test('reports CONFIG_FILE, resolved against ROOTPATH, when it redirected the read', async () => {
    process.env.CONFIG_FILE = 'alt.yml'
    const { configPath, overrides } = await initInFixture()
    assert.equal(configPath, path.join(fixtureDir, 'alt.yml'))
    assert.deepEqual(overrides, ['CONFIG_FILE'])
  })

  test('reports WIKI_PORT when it took the port', async () => {
    process.env.WIKI_PORT = '4321'
    const { overrides } = await initInFixture()
    assert.deepEqual(overrides, ['WIKI_PORT'])
  })

  test('does NOT report PORT when the configured port already stands, since nothing read it', async () => {
    process.env.PORT = '9999'
    const { overrides } = await initInFixture()
    assert.deepEqual(overrides, [])
  })

  test('reports PORT when the configured port is below 1 and it actually supplied one', async () => {
    process.env.CONFIG_FILE = 'no-port.yml'
    process.env.PORT = '9999'
    const { overrides } = await initInFixture()
    assert.deepEqual(overrides, ['CONFIG_FILE', 'PORT'])
  })

  test('reports DB_PASS_FILE only once the secret has actually been read', async () => {
    process.env.DB_PASS_FILE = path.join(fixtureDir, 'secret.txt')
    const { overrides } = await initInFixture()
    assert.deepEqual(overrides, ['DB_PASS_FILE'])
  })

  test('lists several honoured overrides together, in the order init() reads them', async () => {
    process.env.CONFIG_FILE = 'alt.yml'
    process.env.WIKI_PORT = '4321'
    process.env.DB_PASS_FILE = path.join(fixtureDir, 'secret.txt')
    const { overrides } = await initInFixture()
    assert.deepEqual(overrides, ['CONFIG_FILE', 'WIKI_PORT', 'DB_PASS_FILE'])
  })

  test('every name it can report is a member of the closed CONFIG_OVERRIDE_VARS vocabulary', () => {
    assert.deepEqual([...CONFIG_OVERRIDE_VARS], [...OVERRIDE_VARS])
  })
})

describe('the config loaded line', () => {
  test('counts the DB blob top-level keys, not the merged CARDINAL.config', async () => {
    const info = mock.fn()
    const previous = (globalThis as any).CARDINAL
    installTestWiki({
      config: { existingKeyFromYaml: true },
      logger: { ...createSilentLogger(), info },
      models: {
        settings: {
          getConfig: async () => ({ auth: {}, mail: {}, security: {} })
        }
      } as any
    })

    try {
      assert.equal(await configSvc.loadFromDb(), true)
      assert.equal(configSvc.dbKeyCount, 3)
      assert.ok(Object.keys((globalThis as any).CARDINAL.config).length > 3)
    } finally {
      ;(globalThis as any).CARDINAL = previous
    }
  })

  test('leaves the count alone when there is nothing in the settings table to read', async () => {
    const previous = (globalThis as any).CARDINAL
    configSvc.dbKeyCount = 7
    installTestWiki({
      config: {},
      models: { settings: { getConfig: async () => null } } as any
    })

    try {
      assert.equal(await configSvc.loadFromDb(), false)
      assert.equal(configSvc.dbKeyCount, 7)
    } finally {
      configSvc.dbKeyCount = 0
      ;(globalThis as any).CARDINAL = previous
    }
  })
})

describe('init() prints no boot-progress line (OpenProject #2723)', () => {
  let progressDir: string
  let previousProgressWiki: any
  let previousProgressDbPassFile: string | undefined

  before(async () => {
    progressDir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-config-progress-test-'))
    await writeFile(
      path.join(progressDir, 'base.yml'),
      'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n'
    )
    await writeFile(path.join(progressDir, 'config.yml'), 'port: 3000\n')
    await writeFile(
      path.join(progressDir, 'package.json'),
      JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
    )

    // -> The file-level `before()` above exports DB_PASS_FILE for the whole run, which would make
    //    `init()`'s `DB_PASS_FILE is defined...` console.info fire here too.
    previousProgressDbPassFile = process.env.DB_PASS_FILE
    delete process.env.DB_PASS_FILE

    previousProgressWiki = (globalThis as any).CARDINAL
    installTestWiki({ ROOTPATH: progressDir, SERVERPATH: progressDir })
  })

  after(async () => {
    if (previousProgressDbPassFile === undefined) {
      delete process.env.DB_PASS_FILE
    } else {
      process.env.DB_PASS_FILE = previousProgressDbPassFile
    }
    ;(globalThis as any).CARDINAL = previousProgressWiki
    await rm(progressDir, { recursive: true, force: true })
  })

  test('a successful, non-silent init() never writes to stdout or announces OK', async () => {
    // -> `node --test`'s own IPC/reporter frames land on the same `process.stdout.write` while
    //    other tests progress, so this asserts on the CONTENT written rather than the call count.
    const writes: string[] = []
    const write = mock.method(process.stdout, 'write', (chunk: any) => {
      writes.push(String(chunk))
      return true
    })
    const info = mock.method(console, 'info', () => {})

    try {
      await configSvc.init()
    } finally {
      write.mock.restore()
      info.mock.restore()
    }

    assert.ok(
      !writes.some((w) => w.includes('Loading configuration')),
      `init() must never write the removed boot-progress line to stdout: ${JSON.stringify(writes)}`
    )
    assert.equal(info.mock.callCount(), 0, 'init() must never announce success via console.info')
  })

  test('a failing init() reports the error message alone, with no "FAILED" tag, and still exits', async () => {
    const missingConfigDir = await mkdtemp(path.join(tmpdir(), 'cardinaljs-config-missing-test-'))
    await writeFile(
      path.join(missingConfigDir, 'base.yml'),
      'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n'
    )
    // -> No config.yml written: fs.readFile() throws ENOENT, driving the catch branch.

    const previous = (globalThis as any).CARDINAL
    installTestWiki({ ROOTPATH: missingConfigDir, SERVERPATH: missingConfigDir })
    const error = mock.method(console, 'error', () => {})

    try {
      // -> The file-level `before()` above stubs `process.exit` to throw rather than actually exit.
      await assert.rejects(() => configSvc.init(), /process\.exit\(1\) called/)
    } finally {
      error.mock.restore()
      ;(globalThis as any).CARDINAL = previous
      await rm(missingConfigDir, { recursive: true, force: true })
    }

    const messages = error.mock.calls.map((call) => String(call.arguments[0]))
    assert.ok(
      !messages.some((m) => /^FAILED$/.test(m)),
      `expected no bare "FAILED" status tag among: ${JSON.stringify(messages)}`
    )
    assert.ok(
      messages.some((m) => /ENOENT/.test(m)),
      `expected the real fs error message to be reported among: ${JSON.stringify(messages)}`
    )
  })
})

/**
 * Deliberately NOT built on `test/db.ts#setupTestDb()`: that fixture pre-inserts a site/user/group
 * directly, bypassing `initDbValues()`, which would falsify this suite's own precondition — a
 * database that is genuinely still empty. This sets up the bare minimum instead: a fresh schema,
 * migrated, with no rows of its own.
 */
describe('ensureSeeded() (DB-backed)', { skip: !hasTestDatabase() }, () => {
  const SYSTEM_IDS = {
    localAuthId: '5a528c4c-0a82-4ad2-96a5-2b23811e6588',
    guestsGroupId: '10000000-0000-4000-8000-000000000001',
    usersGroupId: '20000000-0000-4000-8000-000000000002',
    classificationPublicId: '30000000-0000-4000-8000-000000000001',
    classificationInternalId: '30000000-0000-4000-8000-000000000002',
    classificationRestrictedId: '30000000-0000-4000-8000-000000000003'
  }

  let pool: Pool
  let schema: string
  let db: WikiDb
  let previousDbWiki: any

  before(async () => {
    schema = `test_${randomBytes(6).toString('hex')}`
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema},public`
    })
    db = drizzle({ client: pool, relations }) as WikiDb

    await db.execute(sql.raw(`CREATE SCHEMA "${schema}"`))
    await createExtensionsSerialized(pool)
    await migrate(db, {
      migrationsFolder: path.join(import.meta.dirname, '../db/migrations'),
      migrationsSchema: schema,
      migrationsTable: 'migrations'
    })

    const models = (await import('../models/index.ts')).default

    previousDbWiki = (globalThis as any).CARDINAL
    wikiHandle = installTestWiki({
      IS_DEBUG: false,
      ROOTPATH: process.cwd(),
      SERVERPATH: path.join(import.meta.dirname, '..'),
      INSTANCE_ID: 'test',
      config: {},
      data: { systemIds: SYSTEM_IDS },
      db,
      logger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {}
      },
      cache: createCacheStub(),
      events: createEventsStub(),
      scheduler: createSchedulerStub(),
      models
    })
  })

  after(async () => {
    if (pool && schema) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
    await pool?.end()
    ;(globalThis as any).CARDINAL = previousDbWiki
  })

  test('exactly one of two concurrent callers seeds; the other observes a fully-seeded DB', async () => {
    const [first, second] = await Promise.all([configSvc.ensureSeeded(), configSvc.ensureSeeded()])

    // -> Exactly one seeds. Unlocked, both would see `loadFromDb()` return `false` and race
    //    straight into `initDbValues()`.
    assert.notEqual(first, second, `expected exactly one seed, got [${first}, ${second}]`)

    const siteCount = await db.$count(sitesTable)
    assert.equal(siteCount, 1, 'expected exactly one seeded site, not zero or a duplicate')

    const groupRows = await db.select({ id: groupsTable.id }).from(groupsTable)
    assert.equal(groupRows.length, 3, 'expected exactly the three standard groups')

    assert.equal(await configSvc.loadFromDb(), true)
  })
})

/**
 * Its own `describe` and fresh schema, rather than a second `test` in the suite above: that
 * database is already seeded by the time this would run, so `ensureSeeded()` would short-circuit on
 * `loadFromDb()` before either caller ever contended for the lock.
 */
describe(
  'ensureSeeded() (DB-backed): loser behind a slow winner',
  { skip: !hasTestDatabase() },
  () => {
    const SYSTEM_IDS = {
      localAuthId: '5a528c4c-0a82-4ad2-96a5-2b23811e6588',
      guestsGroupId: '10000000-0000-4000-8000-000000000001',
      usersGroupId: '20000000-0000-4000-8000-000000000002',
      classificationPublicId: '30000000-0000-4000-8000-000000000001',
      classificationInternalId: '30000000-0000-4000-8000-000000000002',
      classificationRestrictedId: '30000000-0000-4000-8000-000000000003'
    }

    let pool: Pool
    let schema: string
    let db: WikiDb
    let previousDbWiki: any

    before(async () => {
      schema = `test_${randomBytes(6).toString('hex')}`
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schema},public`
      })
      db = drizzle({ client: pool, relations }) as WikiDb

      await db.execute(sql.raw(`CREATE SCHEMA "${schema}"`))
      await createExtensionsSerialized(pool)
      await migrate(db, {
        migrationsFolder: path.join(import.meta.dirname, '../db/migrations'),
        migrationsSchema: schema,
        migrationsTable: 'migrations'
      })

      const models = (await import('../models/index.ts')).default

      previousDbWiki = (globalThis as any).CARDINAL
      wikiHandle = installTestWiki({
        IS_DEBUG: false,
        ROOTPATH: process.cwd(),
        SERVERPATH: path.join(import.meta.dirname, '..'),
        INSTANCE_ID: 'test',
        config: {},
        data: { systemIds: SYSTEM_IDS },
        db,
        logger: {
          error: () => {},
          warn: () => {},
          info: () => {},
          debug: () => {}
        },
        cache: createCacheStub(),
        events: createEventsStub(),
        scheduler: createSchedulerStub(),
        models
      })
    })

    after(async () => {
      if (pool && schema) {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      }
      await pool?.end()
      ;(globalThis as any).CARDINAL = previousDbWiki
    })

    test('the loser observes the fully-seeded DB, not an AdvisoryLockAcquisitionError', async () => {
      const originalInitDbValues = configSvc.initDbValues.bind(configSvc)

      // -> Slows the winner's seed past `withAdvisoryLock`'s worst-case give-up budget at its
      //    defaults (~19s with full jitter), standing in for a heavy fresh-install seed. So this
      //    only passes because `ensureSeeded()` takes the blocking `acquireAdvisoryLock`, which has
      //    no attempt ceiling: the loser waits for as long as the winner holds the lock.
      const initDbValuesMock = mock.method(configSvc, 'initDbValues', async () => {
        await delay(23_000)
        return originalInitDbValues()
      })

      try {
        const results = await Promise.allSettled([
          configSvc.ensureSeeded(),
          configSvc.ensureSeeded()
        ])

        for (const result of results) {
          assert.ok(
            result.status === 'fulfilled',
            result.status === 'rejected'
              ? `expected no rejection, got: ${result.reason?.name}: ${result.reason?.message} ` +
                  `(isAdvisoryLockAcquisitionError=${result.reason instanceof AdvisoryLockAcquisitionError})`
              : ''
          )
        }

        const [first, second] = results.map((r) => (r as PromiseFulfilledResult<boolean>).value)
        assert.notEqual(first, second, `expected exactly one seed, got [${first}, ${second}]`)

        assert.equal(await configSvc.loadFromDb(), true)

        const siteCount = await db.$count(sitesTable)
        assert.equal(siteCount, 1, 'expected exactly one seeded site, not zero or a duplicate')
      } finally {
        initDbValuesMock.mock.restore()
      }
    })
  }
)
