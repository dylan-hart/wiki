import assert from 'node:assert/strict'
import { after, beforeEach, describe, mock, test } from 'node:test'
import { FLAGS, flags } from './flags.ts'
import { installTestWiki } from '../test/mocks.ts'

describe('flags model', () => {
  let wikiHandle: { restore(): void }
  let debugCalls: { scope: string; message: string }[]
  let infoCalls: { scope: string; message: string; fields?: Record<string, unknown> }[]

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    debugCalls = []
    infoCalls = []
    wikiHandle = installTestWiki({
      config: { flags: { experimental: false, authDebug: false, sqlLog: false } },
      configSvc: { saveToDb: mock.fn(async () => true) },
      logger: {
        error: () => {},
        warn: () => {},
        info: (scope: string, message: string, fields?: Record<string, unknown>) => {
          infoCalls.push({ scope, message, fields })
        },
        debug: (scope: string, message: string) => {
          debugCalls.push({ scope, message })
        }
      }
    })
  })

  describe('getFlags() / isEnabled()', () => {
    test('a flag missing from the stored blob reads as off, not undefined', () => {
      CARDINAL.config.flags = { experimental: true }

      assert.deepEqual(flags.getFlags(), {
        experimental: true,
        authDebug: false,
        sqlLog: false
      })
      assert.equal(flags.isEnabled('sqlLog'), false)
    })

    test('only a literal true counts as on', () => {
      CARDINAL.config.flags = { sqlLog: 'true', authDebug: 1 }

      assert.equal(flags.isEnabled('sqlLog'), false)
      assert.equal(flags.isEnabled('authDebug'), false)
    })
  })

  describe('logScopeOverrides()', () => {
    test('both flags off: no scope has an override at all', () => {
      // -> An empty map, not `{ sql: 'info' }`: absence is what lets `logScopes:` and then
      //    `logLevel` answer for the scope instead.
      assert.deepEqual(flags.logScopeOverrides(), {})
    })

    test('sqlLog on raises the sql scope to debug, and nothing else', () => {
      CARDINAL.config.flags.sqlLog = true

      assert.deepEqual(flags.logScopeOverrides(), { sql: 'debug' })
    })

    test('authDebug on raises the auth scope to debug, and nothing else', () => {
      CARDINAL.config.flags.authDebug = true

      assert.deepEqual(flags.logScopeOverrides(), { auth: 'debug' })
    })

    test('both on raises both', () => {
      CARDINAL.config.flags.sqlLog = true
      CARDINAL.config.flags.authDebug = true

      assert.deepEqual(flags.logScopeOverrides(), { sql: 'debug', auth: 'debug' })
    })

    test('the map is re-derived per call, so flipping a flag needs no restart', () => {
      assert.deepEqual(flags.logScopeOverrides(), {})

      CARDINAL.config.flags.sqlLog = true
      assert.deepEqual(flags.logScopeOverrides(), { sql: 'debug' })

      CARDINAL.config.flags.sqlLog = false
      assert.deepEqual(flags.logScopeOverrides(), {})
    })

    test('the experimental flag is not a log scope override', () => {
      CARDINAL.config.flags.experimental = true

      assert.deepEqual(flags.logScopeOverrides(), {})
    })
  })

  describe('authDebug()', () => {
    test('emits a debug auth line with the flag off, and lets the threshold drop it', () => {
      flags.authDebug('local login attempt for user 42')

      assert.deepEqual(debugCalls, [{ scope: 'auth', message: 'local login attempt for user 42' }])
    })

    test('emits the same line with the flag on — the flag is not a gate here', () => {
      CARDINAL.config.flags.authDebug = true

      flags.authDebug('local login attempt for user 42')

      assert.deepEqual(debugCalls, [{ scope: 'auth', message: 'local login attempt for user 42' }])
    })

    test('never emits at info, whatever the flag says', () => {
      CARDINAL.config.flags.authDebug = true

      flags.authDebug('a detail')

      assert.deepEqual(infoCalls, [])
    })
  })

  describe('pickFlags() / updateFlags()', () => {
    test('pickFlags keeps only the flags this model owns', () => {
      assert.deepEqual(flags.pickFlags({ sqlLog: true, notAFlag: true, experimental: false }), {
        sqlLog: true,
        experimental: false
      })
    })

    test('a saved patch logs one config line per changed flag and leaves the rest alone', async () => {
      assert.equal(await flags.updateFlags({ sqlLog: true }), true)

      assert.deepEqual(CARDINAL.config.flags, {
        experimental: false,
        authDebug: false,
        sqlLog: true
      })
      assert.deepEqual(infoCalls, [
        {
          scope: 'config',
          message: 'system flag changed',
          fields: { key: 'sqlLog', enabled: true }
        }
      ])
    })

    test('a failed save rolls the flags back and reports it, logging nothing', async () => {
      CARDINAL.configSvc.saveToDb = mock.fn(async () => false)

      assert.equal(await flags.updateFlags({ sqlLog: true }), false)

      assert.equal(flags.isEnabled('sqlLog'), false)
      assert.deepEqual(infoCalls, [])
    })
  })

  /**
   * The descriptions are what an administrator reads next to the switch, so one that promises
   * "queries are logged" without naming the scope it raises describes a switch that does not exist.
   */
  describe('FLAGS descriptions', () => {
    test('each flag in the union has a description', () => {
      for (const [key, description] of Object.entries(FLAGS)) {
        assert.equal(typeof description, 'string', `${key} needs a description`)
        assert.ok(description.length > 0, `${key} needs a description`)
      }
    })

    test('the two log flags say which scope they raise', () => {
      assert.match(FLAGS.sqlLog, /`sql` log scope/)
      assert.match(FLAGS.authDebug, /`auth` log scope/)
    })

    test('sqlLog still warns that a bound parameter can carry a credential', () => {
      // -> The values are redacted, but an administrator turning this on should still know what
      //    class of data the line sits near.
      assert.match(FLAGS.sqlLog, /never its value/)
      assert.match(FLAGS.sqlLog, /credential/i)
    })
  })
})
