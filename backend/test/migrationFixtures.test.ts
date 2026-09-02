import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  iterate,
  LEGACY_SCHEMA_DDL,
  makeSourcePageRow,
  makeStagedPage,
  stubSourceConnector
} from './migrationFixtures.ts'
import { NotYetImplementedError } from '../migration/connector.ts'

describe('iterate', () => {
  test('yields an array in order, and nothing for an empty one', async () => {
    const seen: number[] = []
    for await (const value of iterate([1, 2, 3])) {
      seen.push(value)
    }
    assert.deepEqual(seen, [1, 2, 3])
    for await (const _ of iterate([])) {
      assert.fail('an empty array should yield nothing')
    }
  })
})

describe('stubSourceConnector', () => {
  test('every generator throws NotYetImplementedError by default', () => {
    const connector = stubSourceConnector()
    for (const entity of [
      'users',
      'groups',
      'pages',
      'pageHistory',
      'tags',
      'navigation',
      'settings',
      'comments',
      'assets'
    ] as const) {
      assert.throws(() => connector[entity](), NotYetImplementedError, `${entity} should throw`)
    }
  })

  test('an override supplies one working generator and leaves the rest throwing', async () => {
    const connector = stubSourceConnector({ pages: () => iterate([makeSourcePageRow()]) })
    const rows = []
    for await (const row of connector.pages()) {
      rows.push(row)
    }
    assert.equal(rows.length, 1)
    assert.throws(() => connector.users(), NotYetImplementedError)
  })

  test('connect/disconnect/describe resolve so a phase can run end to end', async () => {
    const connector = stubSourceConnector()
    await connector.connect()
    assert.equal((await connector.describe()).kind, 'postgres')
    await connector.disconnect()
  })
})

describe('page-row builders', () => {
  test('a source row carries the 2.5.x columns the importers read', () => {
    const row = makeSourcePageRow() as any
    assert.equal(row.localeCode, 'en')
    assert.equal(row.editorKey, 'markdown')
    assert.equal(row.isPublished, true)
    assert.equal(makeSourcePageRow({ localeCode: 'fr' }).localeCode, 'fr')
  })

  test('a staged page carries resolved UUID authors and an empty history chain', () => {
    const staged = makeStagedPage()
    assert.equal(staged.authorId, 'actor-1')
    assert.equal(staged.creatorId, 'actor-1')
    assert.deepEqual(staged.history, [])
    assert.equal(makeStagedPage({ path: 'other' }).path, 'other')
  })
})

describe('LEGACY_SCHEMA_DDL', () => {
  test('is a per-table opt-in map, with the narrow and wide pages shapes kept apart', () => {
    assert.ok(LEGACY_SCHEMA_DDL.pages!.includes('CREATE TABLE pages'))
    assert.equal(LEGACY_SCHEMA_DDL.pages!.includes('localeCode'), false)
    assert.ok(LEGACY_SCHEMA_DDL.pagesFull!.includes('localeCode'))
  })

  test('every entry is a single CREATE TABLE statement', () => {
    for (const [name, ddl] of Object.entries(LEGACY_SCHEMA_DDL)) {
      assert.equal(
        ddl.match(/CREATE TABLE/g)?.length,
        1,
        `${name} should declare exactly one table`
      )
    }
  })
})
