import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createSilentLogger, createWikiStub, installTestWiki } from './mocks.ts'

/**
 * The `WIKI`-stub half of the harness (TEST-F1). What matters here is the two defaults the rest of
 * the suite depends on being exactly what they are: an EMPTY `models` (so an unexpected model reach
 * still throws), and a deep merge that keeps the stubbed members a suite did not name.
 */

describe('createWikiStub', () => {
  test('defaults models to {} so an absent member still throws', () => {
    const wiki = createWikiStub()
    assert.deepEqual(wiki.models, {})
    assert.throws(() => (wiki.models as any).pages.getPage(), TypeError)
  })

  test('stubs the members almost no test cares about', () => {
    const wiki = createWikiStub()
    assert.equal(typeof wiki.logger.warn, 'function')
    assert.equal(typeof wiki.cache.get, 'function')
    assert.equal(typeof wiki.events.inbound.emit, 'function')
    assert.equal(typeof (wiki.scheduler as any).addJob, 'function')
    assert.deepEqual(wiki.sites, {})
    assert.deepEqual(wiki.sitesMappings, {})
  })

  test('data.systemIds reads as undefined rather than throwing', () => {
    assert.equal(createWikiStub().data.systemIds.guestsGroupId, undefined)
  })

  test('overrides deep-merge, keeping the members they did not name', () => {
    const wiki = createWikiStub({ models: { pages: { getPage: async () => null } } })
    assert.equal(typeof (wiki.models as any).pages.getPage, 'function')
    assert.equal(typeof wiki.logger.info, 'function')
  })

  test('an override replaces an array or a class instance wholesale, never index-merging it', () => {
    const marker = new Map([['live', true]])
    const wiki = createWikiStub({
      config: { security: { allowed: ['a', 'b'] } },
      db: marker as any
    })
    assert.deepEqual(wiki.config.security.allowed, ['a', 'b'])
    assert.equal(wiki.db as unknown as Map<string, boolean>, marker)
  })
})

describe('installTestWiki', () => {
  test('installs the stub and puts back an absent global on restore', () => {
    assert.equal('WIKI' in globalThis, false)
    const handle = installTestWiki({ config: { marker: 1 } })
    assert.equal(WIKI.config.marker, 1)
    handle.restore()
    assert.equal('WIKI' in globalThis, false)
  })

  test('puts back a pre-existing global on restore', () => {
    const sentinel = { marker: 'outer' } as any
    ;(globalThis as any).WIKI = sentinel
    const handle = installTestWiki()
    assert.notEqual((globalThis as any).WIKI, sentinel)
    handle.restore()
    assert.equal((globalThis as any).WIKI, sentinel)
    delete (globalThis as any).WIKI
  })
})

describe('createSilentLogger', () => {
  test('answers every level the app logs at, all no-ops', () => {
    const logger = createSilentLogger()
    for (const level of ['error', 'warn', 'info', 'debug', 'verbose', 'silly']) {
      assert.equal(typeof logger[level], 'function')
      assert.equal(logger[level]('anything'), undefined)
    }
  })
})
