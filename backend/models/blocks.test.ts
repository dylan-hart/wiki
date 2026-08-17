import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { blocks as blocksTable } from '../db/schema.ts'
import type { BlockDefinition } from './blocks.ts'

/**
 * `getSiteBlocks` attaches `configFields` from the in-memory manifest (`this.definitions`), the same
 * way it already attaches `props` and `template` — never from the row, since it describes the
 * installed code rather than the site's own copy of it. This suite runs against a real row so it
 * proves the merge, not just the shape of the return value.
 */
describe('blocks.getSiteBlocks (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let blocksModel: typeof import('./blocks.ts').blocks

  before(async () => {
    fixtures = await setupTestDb()
    ;({ blocks: blocksModel } = await import('./blocks.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('configFields is read from the manifest definition, keyed by block, not from the row', async () => {
    const definition: BlockDefinition = {
      block: 'map',
      name: 'Map',
      description: 'Shows a location on a map.',
      icon: 'geography',
      props: [{ name: 'lat', type: 'number', required: true }],
      config: [
        {
          name: 'tileServerUrl',
          type: 'string',
          label: 'Tile Server URL',
          default: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
        },
        { name: 'apiKey', type: 'string', label: 'API Key' }
      ]
    }
    blocksModel.definitions = [definition]

    await fixtures.db.insert(blocksTable).values({
      siteId: fixtures.siteId,
      block: 'map',
      name: 'Map',
      description: 'Shows a location on a map.',
      icon: 'geography',
      isEnabled: true,
      isCustom: false,
      config: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' }
    })

    const result = await blocksModel.getSiteBlocks(fixtures.siteId)
    const mapBlock = result.find((b) => b.block === 'map')

    assert.ok(mapBlock)
    assert.deepEqual(mapBlock!.configFields, definition.config)
    // -> The site's own admin-set values live on `config` (the row), untouched by `configFields`
    assert.deepEqual(mapBlock!.config, { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' })
  })

  test('a custom block, having no manifest entry, reports an empty configFields', async () => {
    blocksModel.definitions = []

    await fixtures.db.insert(blocksTable).values({
      siteId: fixtures.siteId,
      block: 'custom-thing',
      name: 'Custom Thing',
      description: 'A custom block.',
      icon: 'cube',
      isEnabled: true,
      isCustom: true,
      config: {}
    })

    const result = await blocksModel.getSiteBlocks(fixtures.siteId)
    const custom = result.find((b) => b.block === 'custom-thing')

    assert.ok(custom)
    assert.deepEqual(custom!.configFields, [])
  })
})
