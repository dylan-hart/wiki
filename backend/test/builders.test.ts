import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  makeActor,
  makeGroupRule,
  makeIndexablePage,
  makeRulePageRef,
  makeSite,
  makeStorageTarget,
  stubSelect
} from './builders.ts'

describe('rule and actor builders', () => {
  test('a rule defaults to an ALLOW read:pages START rule, overridable field by field', () => {
    assert.deepEqual(makeGroupRule(), {
      id: 'rule-1',
      name: 'Test Rule',
      roles: ['read:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: [],
      sites: []
    })
    const denied = makeGroupRule({ mode: 'DENY', path: 'secret' })
    assert.equal(denied.mode, 'DENY')
    assert.equal(denied.path, 'secret')
    assert.deepEqual(denied.roles, ['read:pages'])
  })

  test('a page ref defaults to an untagged, unclassified en page', () => {
    const page = makeRulePageRef({ path: 'docs/one' })
    assert.equal(page.path, 'docs/one')
    assert.equal(page.locale, 'en')
    assert.equal(page.siteId, null)
    assert.deepEqual(page.tags, [])
  })

  test('an actor defaults to holding nothing at all', () => {
    assert.deepEqual(makeActor(), { id: 'user-1', permissions: [], groupIds: [] })
    assert.deepEqual(makeActor({ permissions: ['manage:system'] }).permissions, ['manage:system'])
  })
})

describe('makeSite', () => {
  test('carries the locales block every site-config read expects', () => {
    assert.deepEqual(makeSite().config.locales, { primary: 'en', active: ['en'] })
  })

  test('a config override merges into that block rather than erasing it', () => {
    const site = makeSite({ id: 'site-2', config: { theme: { primary: '#fff' } } })
    assert.equal(site.id, 'site-2')
    assert.deepEqual(site.config.locales, { primary: 'en', active: ['en'] })
    assert.deepEqual(site.config.theme, { primary: '#fff' })
  })
})

describe('makeStorageTarget', () => {
  test('defaults to the blob-module shape, with a fresh id per call', () => {
    const a = makeStorageTarget('azure')
    const b = makeStorageTarget('azure')
    assert.notEqual(a.id, b.id)
    assert.equal(a.module, 'azure')
    assert.equal(a.title, 'Test azure')
    assert.deepEqual(a.config, {})
    assert.equal(a.assetDelivery.isStreamingSupported, true)
  })

  test('a differing capability block replaces wholesale, never merging over the default', () => {
    const git = makeStorageTarget('git', {
      versioning: { isSupported: true, isForceEnabled: true, enabled: true },
      sync: {
        supportedModes: ['sync', 'push', 'pull'],
        schedule: false,
        mode: 'sync',
        scheduleOverride: null
      }
    })
    assert.deepEqual(git.versioning, { isSupported: true, isForceEnabled: true, enabled: true })
    assert.equal('supportsContentSync' in git.sync, false)
  })
})

describe('makeIndexablePage', () => {
  test('carries the full field superset a search module may index', () => {
    const page = makeIndexablePage() as any
    for (const field of [
      'id',
      'siteId',
      'locale',
      'path',
      'title',
      'description',
      'icon',
      'tags',
      'editor',
      'publishState',
      'isSearchable',
      'classification',
      'password',
      'searchContent',
      'updatedAt',
      'createdAt',
      'authorId'
    ]) {
      assert.ok(field in page, `expected the superset to carry ${field}`)
    }
    assert.equal(makeIndexablePage({ path: 'docs/other' }).path, 'docs/other')
  })
})

describe('stubSelect', () => {
  test('answers one row through from/where/limit, recording the conditions', async () => {
    const { select, calls } = stubSelect({ hash: 'abc' })
    const rows = await select().from({}).where('id = 1').limit(1)
    assert.deepEqual(rows, [{ hash: 'abc' }])
    assert.deepEqual(calls.where, ['id = 1'])
  })

  test('answers nothing for a null row, and exposes only the joins it was told about', async () => {
    const { select } = stubSelect(null, { joins: ['leftJoin'] })
    assert.deepEqual(await select().from({}).leftJoin({}, {}).where('x').limit(1), [])
    assert.equal((select() as any).innerJoin, undefined)
  })
})
