import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createCacheStub, createEventsStub, loadModels } from './bootstrap.ts'

/**
 * Every model name a built migration importer reaches, directly or transitively, through
 * `WIKI.models`. Kept as an explicit list rather than asserting against a snapshot of whatever
 * `loadModels()` currently returns, so a write path gaining a new model call (the way `createPage()`
 * already reaches `locales`/`rendering`/`search`/`hooks`/`flags`/`classificationLevels`) fails this
 * test loudly instead of silently passing because the snapshot moved with it. See `loadModels()`'s
 * own doc comment in `bootstrap.ts` for which importer calls each of these.
 */
const EXPECTED_MODEL_NAMES = [
  'sites',
  'settings',
  'users',
  'groups',
  'authentication',
  'storage',
  'tags',
  'tree',
  'pages',
  'pageHistory',
  'assets',
  'locales',
  'rendering',
  'search',
  'hooks',
  'flags',
  'classificationLevels',
  'navigation'
]

describe('migration bootstrap', () => {
  test('loadModels() resolves every model a built importer calls through WIKI.models', async () => {
    const models = await loadModels()
    for (const name of EXPECTED_MODEL_NAMES) {
      assert.ok(
        (models as Record<string, unknown>)[name],
        `expected WIKI.models.${name} to be loaded`
      )
    }
  })

  test('createEventsStub() exposes both buses write paths emit through', () => {
    const events = createEventsStub()
    assert.equal(typeof events.inbound.emit, 'function')
    assert.equal(typeof events.outbound.emit, 'function')
    // -> models/groups.ts#broadcastReload's WIKI.events.outbound.emit('reloadGroups') must not throw
    assert.doesNotThrow(() => events.outbound.emit('reloadGroups'))
  })

  test('createCacheStub() exposes the full LRUCache-shaped surface write paths call', () => {
    const cache = createCacheStub()
    assert.equal(typeof cache.get, 'function')
    assert.equal(typeof cache.set, 'function')
    assert.equal(typeof cache.has, 'function')
    assert.equal(typeof cache.delete, 'function')
    assert.equal(typeof cache.getRemainingTTL, 'function')
    assert.equal(typeof cache.clear, 'function')

    cache.set('key', 'value')
    assert.equal(cache.has('key'), true)
    assert.equal(cache.get('key'), 'value')
    cache.delete('key')
    assert.equal(cache.has('key'), false)
  })
})
