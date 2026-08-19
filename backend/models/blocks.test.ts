import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { blockCode as blockCodeTable, blocks as blocksTable } from '../db/schema.ts'
import type { BlockDefinition } from './blocks.ts'

/**
 * `getSiteBlocks()`, `getCustomBlockCode()` and `deleteCustomBlock()` are all SQL orchestration over
 * two related tables (`blocks`, `blockCode`) — which column a custom row's props/template come from,
 * and which rows a delete removes, is squarely what a mock of the query builder would just be
 * re-describing rather than verifying. This suite runs the real methods against a migrated,
 * per-run-fresh database (see `test/db.ts`).
 */
describe('blocks custom-block storage (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let blocksModel: typeof import('./blocks.ts').blocks

  before(async () => {
    fixtures = await setupTestDb()
    ;({ blocks: blocksModel } = await import('./blocks.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Inserts a custom block row (and, unless `withCode` is false, its code row) directly via Drizzle — there is no upload route yet for this task to go through. */
  async function insertCustomBlock(
    overrides: Partial<typeof blocksTable.$inferInsert> = {},
    { withCode = true }: { withCode?: boolean } = {}
  ): Promise<string> {
    const [row] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'my-widget',
        name: 'My Widget',
        description: 'A custom widget',
        icon: 'mdi:widgets',
        isEnabled: true,
        isCustom: true,
        props: [{ name: 'title', type: 'string', label: 'Title' }],
        template: 'Body content',
        elementTag: 'my-custom-widget',
        ...overrides
      })
      .returning({ id: blocksTable.id })
    if (withCode) {
      await fixtures.db.insert(blockCodeTable).values({
        blockId: row!.id,
        code: Buffer.from('export class MyWidget {}')
      })
    }
    return row!.id
  }

  test('getSiteBlocks sources props/template/elementTag from the row for a custom block', async () => {
    await insertCustomBlock()

    const result = await blocksModel.getSiteBlocks(fixtures.siteId)
    const custom = result.find((b) => b.block === 'my-widget')

    assert.ok(custom, 'custom block should be listed')
    assert.deepEqual(custom!.props, [{ name: 'title', type: 'string', label: 'Title' }])
    assert.equal(custom!.template, 'Body content')
    assert.equal(custom!.elementTag, 'my-custom-widget')
  })

  test('getSiteBlocks falls back to `block-{block}` when a custom row has no elementTag override', async () => {
    await insertCustomBlock({ block: 'no-tag-widget', elementTag: '' })

    const result = await blocksModel.getSiteBlocks(fixtures.siteId)
    const custom = result.find((b) => b.block === 'no-tag-widget')

    assert.ok(custom)
    assert.equal(custom!.elementTag, 'block-no-tag-widget')
  })

  test('getSiteBlocks does not source props/template from a built-in row even though the columns exist', async () => {
    // -> A built-in row as `syncSite()` would actually write one: isCustom false, and the new columns
    //    left at their schema defaults. `this.definitions` is empty in this suite (no manifest loaded),
    //    so a built-in reporting anything but empty props/template here would mean the branch in
    //    `getSiteBlocks()` picked the row instead of the manifest.
    await fixtures.db.insert(blocksTable).values({
      siteId: fixtures.siteId,
      block: 'builtin-widget',
      name: 'Builtin Widget',
      description: 'A built-in block',
      icon: 'mdi:cube',
      isEnabled: true,
      isCustom: false
    })

    const result = await blocksModel.getSiteBlocks(fixtures.siteId)
    const builtin = result.find((b) => b.block === 'builtin-widget')

    assert.ok(builtin)
    assert.deepEqual(builtin!.props, [])
    assert.equal(builtin!.template, '')
    assert.equal(builtin!.elementTag, 'block-builtin-widget')
  })

  test('getCustomBlockCode returns the stored code bytes for a custom block on the right site', async () => {
    const id = await insertCustomBlock({ block: 'code-widget' })

    const code = await blocksModel.getCustomBlockCode(fixtures.siteId, id)
    assert.ok(code)
    assert.equal(Buffer.from(code!).toString('utf8'), 'export class MyWidget {}')
  })

  test('getCustomBlockCode returns undefined for a mismatched site, an unknown id, or a built-in block', async () => {
    const id = await insertCustomBlock({ block: 'scoped-widget' })

    const [otherSite] = await fixtures.db
      .insert((await import('../db/schema.ts')).sites)
      .values({ hostname: 'other.localhost', isEnabled: true, config: {} })
      .returning({ id: (await import('../db/schema.ts')).sites.id })

    assert.equal(await blocksModel.getCustomBlockCode(otherSite!.id, id), undefined)
    assert.equal(
      await blocksModel.getCustomBlockCode(fixtures.siteId, '00000000-0000-0000-0000-000000000000'),
      undefined
    )

    const [builtinRow] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'no-code-builtin',
        name: 'No Code',
        description: 'built-in',
        icon: 'mdi:cube',
        isEnabled: true,
        isCustom: false
      })
      .returning({ id: blocksTable.id })
    assert.equal(await blocksModel.getCustomBlockCode(fixtures.siteId, builtinRow!.id), undefined)
  })

  test('deleteCustomBlock removes the block row and its stored code together', async () => {
    const id = await insertCustomBlock({ block: 'deletable-widget' })

    const deleted = await blocksModel.deleteCustomBlock(fixtures.siteId, id)
    assert.equal(deleted, true)

    const [blockRow] = await fixtures.db.select().from(blocksTable).where(eq(blocksTable.id, id))
    assert.equal(blockRow, undefined, 'block row should be gone')

    const [codeRow] = await fixtures.db
      .select()
      .from(blockCodeTable)
      .where(eq(blockCodeTable.blockId, id))
    assert.equal(codeRow, undefined, 'code row should be gone, not left as an orphan')
  })

  test('isTagTaken is true for a tag in the in-memory built-in manifest', async () => {
    blocksModel.definitions = [
      { block: 'manifest-widget', name: 'Manifest Widget', description: '', icon: 'mdi:cube' }
    ]
    try {
      assert.equal(await blocksModel.isTagTaken(fixtures.siteId, 'manifest-widget'), true)
    } finally {
      blocksModel.definitions = []
    }
  })

  test('isTagTaken is true for a tag already used by another custom block on the site', async () => {
    await insertCustomBlock({ block: 'taken-widget' })
    assert.equal(await blocksModel.isTagTaken(fixtures.siteId, 'taken-widget'), true)
  })

  test('isTagTaken is false for a tag nothing on the site uses', async () => {
    assert.equal(await blocksModel.isTagTaken(fixtures.siteId, 'never-used-widget'), false)
  })

  test('isTagTaken does not see a custom tag registered on a different site', async () => {
    await insertCustomBlock({ block: 'other-site-widget' })

    const [otherSite] = await fixtures.db
      .insert((await import('../db/schema.ts')).sites)
      .values({ hostname: 'istagtaken.localhost', isEnabled: true, config: {} })
      .returning({ id: (await import('../db/schema.ts')).sites.id })

    assert.equal(await blocksModel.isTagTaken(otherSite!.id, 'other-site-widget'), false)
  })

  test('createCustomBlock writes the blocks row and its code together, enabled by default', async () => {
    const created = await blocksModel.createCustomBlock(
      fixtures.siteId,
      {
        block: 'fresh-widget',
        name: 'Fresh Widget',
        description: 'Just uploaded',
        icon: 'mdi:new-box',
        props: [{ name: 'title', type: 'string' }],
        template: 'Starter body'
      },
      Buffer.from('export class FreshWidget {}')
    )

    assert.equal(created.block, 'fresh-widget')
    assert.equal(created.isCustom, true)
    assert.equal(created.isEnabled, true)
    assert.equal(created.template, 'Starter body')
    assert.deepEqual(created.props, [{ name: 'title', type: 'string' }])
    assert.deepEqual(created.configFields, [])
    // -> No override extracted for this upload, so it falls back the same way `getSiteBlocks()` does
    assert.equal(created.elementTag, 'block-fresh-widget')

    const code = await blocksModel.getCustomBlockCode(fixtures.siteId, created.id)
    assert.equal(Buffer.from(code!).toString('utf8'), 'export class FreshWidget {}')

    const listed = await blocksModel.getSiteBlocks(fixtures.siteId)
    assert.ok(
      listed.find((b) => b.id === created.id),
      'row is immediately visible to getSiteBlocks'
    )
  })

  test('createCustomBlock defaults props/template to empty when the definition omits them', async () => {
    const created = await blocksModel.createCustomBlock(
      fixtures.siteId,
      {
        block: 'bare-widget',
        name: 'Bare Widget',
        description: 'No props or template',
        icon: 'mdi:cube-outline'
      },
      Buffer.from('export class BareWidget {}')
    )

    assert.deepEqual(created.props, [])
    assert.equal(created.template, '')
  })

  test('deleteCustomBlock returns false and leaves everything alone for a built-in block', async () => {
    const [builtinRow] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'protected-builtin',
        name: 'Protected',
        description: 'built-in',
        icon: 'mdi:cube',
        isEnabled: true,
        isCustom: false
      })
      .returning({ id: blocksTable.id })

    const deleted = await blocksModel.deleteCustomBlock(fixtures.siteId, builtinRow!.id)
    assert.equal(deleted, false)

    const [stillThere] = await fixtures.db
      .select()
      .from(blocksTable)
      .where(eq(blocksTable.id, builtinRow!.id))
    assert.ok(stillThere, 'built-in row must not be deleted')
  })
})

/**
 * `getSiteBlocks` attaches `configFields` from the in-memory manifest (`this.definitions`), the same
 * way it already attaches `props` and `template` — never from the row, since it describes the
 * installed code rather than the site's own copy of it. This suite runs against a real row so it
 * proves the merge, not just the shape of the return value.
 */
describe('blocks.getSiteBlocks configFields (DB-backed)', { skip: !hasTestDatabase() }, () => {
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

/**
 * `setBlocksState` writes `config` alongside `isEnabled`, sanitised against the block's declared
 * `config` fields (from the manifest, keyed by the row's `block`, not by anything in the request
 * body — see the comment on `sanitizeConfig` for why a stale key is stripped rather than kept). A
 * custom block, having no manifest declaration, is the one case that bypasses sanitization entirely.
 */
describe('blocks.setBlocksState (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let blocksModel: typeof import('./blocks.ts').blocks

  before(async () => {
    fixtures = await setupTestDb()
    ;({ blocks: blocksModel } = await import('./blocks.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('writes config, stripping keys the block no longer declares', async () => {
    blocksModel.definitions = [
      {
        block: 'map',
        name: 'Map',
        description: 'Shows a location on a map.',
        icon: 'geography',
        config: [{ name: 'tileServerUrl', type: 'string' }]
      }
    ]

    const [row] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'map',
        name: 'Map',
        description: 'Shows a location on a map.',
        icon: 'geography',
        isEnabled: true,
        isCustom: false,
        config: {}
      })
      .returning({ id: blocksTable.id })

    const updated = await blocksModel.setBlocksState(fixtures.siteId, [
      {
        id: row!.id,
        isEnabled: true,
        config: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png', staleKey: 'gone' }
      }
    ])

    assert.equal(updated, 1)
    const [siteBlock] = (await blocksModel.getSiteBlocks(fixtures.siteId)).filter(
      (b) => b.id === row!.id
    )
    assert.deepEqual(siteBlock!.config, { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' })
  })

  test('a custom block config is written as-is, not sanitized against any declared field', async () => {
    blocksModel.definitions = []

    const [row] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'custom-widget',
        name: 'Custom Widget',
        description: 'A custom block',
        icon: 'mdi:cube',
        isEnabled: true,
        isCustom: true,
        config: {}
      })
      .returning({ id: blocksTable.id })

    const updated = await blocksModel.setBlocksState(fixtures.siteId, [
      { id: row!.id, isEnabled: true, config: { anything: 'goes', another: 1 } }
    ])

    assert.equal(updated, 1)
    const [siteBlock] = (await blocksModel.getSiteBlocks(fixtures.siteId)).filter(
      (b) => b.id === row!.id
    )
    assert.deepEqual(siteBlock!.config, { anything: 'goes', another: 1 })
  })

  test('a block already in its target isEnabled/config state still counts toward updated', async () => {
    blocksModel.definitions = [
      {
        block: 'map',
        name: 'Map',
        description: 'Shows a location on a map.',
        icon: 'geography',
        config: [{ name: 'tileServerUrl', type: 'string' }]
      }
    ]

    const [row] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'map',
        name: 'Map',
        description: 'Shows a location on a map.',
        icon: 'geography',
        isEnabled: true,
        isCustom: false,
        config: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' }
      })
      .returning({ id: blocksTable.id })

    const updated = await blocksModel.setBlocksState(fixtures.siteId, [
      {
        id: row!.id,
        isEnabled: true,
        config: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' }
      }
    ])

    assert.equal(updated, 1)
  })

  test('a state with no config only writes isEnabled, leaving the row config untouched', async () => {
    blocksModel.definitions = [
      {
        block: 'map',
        name: 'Map',
        description: 'Shows a location on a map.',
        icon: 'geography',
        config: [{ name: 'tileServerUrl', type: 'string' }]
      }
    ]

    const [row] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'map',
        name: 'Map',
        description: 'Shows a location on a map.',
        icon: 'geography',
        isEnabled: false,
        isCustom: false,
        config: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' }
      })
      .returning({ id: blocksTable.id })

    const updated = await blocksModel.setBlocksState(fixtures.siteId, [
      { id: row!.id, isEnabled: true }
    ])

    assert.equal(updated, 1)
    const [siteBlock] = (await blocksModel.getSiteBlocks(fixtures.siteId)).filter(
      (b) => b.id === row!.id
    )
    assert.equal(siteBlock!.isEnabled, true)
    assert.deepEqual(siteBlock!.config, { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' })
  })
})
