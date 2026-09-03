import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  blockCode as blockCodeTable,
  blocks as blocksTable,
  pageRenderQueue as pageRenderQueueTable,
  pages as pagesTable
} from '../db/schema.ts'
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

  test('getSiteBlocks sources props/template from the row for a custom block, and elementTag is always block-{block}', async () => {
    await insertCustomBlock()

    const result = await blocksModel.getSiteBlocks(fixtures.siteId)
    const custom = result.find((b) => b.block === 'my-widget')

    assert.ok(custom, 'custom block should be listed')
    assert.deepEqual(custom!.props, [{ name: 'title', type: 'string', label: 'Title' }])
    assert.equal(custom!.template, 'Body content')
    assert.equal(custom!.elementTag, 'block-my-widget')
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

  test('syncSite is safe to call concurrently for the same site: exactly one row per block key', async () => {
    // -> Regression for task 1659: two instances booting together both read the same "not present
    //    yet" snapshot and both reach the insert. `blocks_composite_idx` +
    //    `onConflictDoNothing` is what keeps that from writing two rows for the same block.
    blocksModel.definitions = [
      { block: 'boot-race-widget', name: 'Boot Race Widget', description: 'x', icon: 'mdi:cube' }
    ]
    try {
      await Promise.all([
        blocksModel.syncSite(fixtures.siteId),
        blocksModel.syncSite(fixtures.siteId)
      ])

      const rows = await fixtures.db
        .select()
        .from(blocksTable)
        .where(
          and(eq(blocksTable.siteId, fixtures.siteId), eq(blocksTable.block, 'boot-race-widget'))
        )
      assert.equal(rows.length, 1, 'exactly one row should exist for the block key')
    } finally {
      blocksModel.definitions = []
    }
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

  test('a createCustomBlock race on the same tag surfaces as a 409 CustomError, not a raw 23505', async () => {
    // -> `isTagTaken()` is only a pre-check, not an atomic reservation: two uploads for the same tag
    //    can both pass it and both reach the insert, so `blocks_composite_idx` (task 1659) is what
    //    actually decides the winner. Exactly one of the two should succeed either way.
    const definition = (): BlockDefinition => ({
      block: 'race-widget',
      name: 'Race Widget',
      description: 'Uploaded twice at once',
      icon: 'mdi:cube'
    })
    const results = await Promise.allSettled([
      blocksModel.createCustomBlock(fixtures.siteId, definition(), Buffer.from('a')),
      blocksModel.createCustomBlock(fixtures.siteId, definition(), Buffer.from('b'))
    ])
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    assert.equal(results.length - rejected.length, 1, 'exactly one upload should win the race')
    for (const r of rejected) {
      assert.equal((r.reason as any).statusCode, 409)
      assert.equal((r.reason as any).name, 'blockTagTaken')
    }

    const rows = await fixtures.db
      .select()
      .from(blocksTable)
      .where(and(eq(blocksTable.siteId, fixtures.siteId), eq(blocksTable.block, 'race-widget')))
    assert.equal(rows.length, 1, 'exactly one row should have been written for the tag')
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

  /**
   * WP #1745: block-kroki's `server` field lives on `props` (an author's per-use setting) and, since
   * this fix, also on `config` (an admin's site-wide default) — mirroring block-map's
   * `tileServerUrl`/`apiKey` pair above. Before the fix, `config` on block-kroki's manifest was
   * missing entirely, so `sanitizeConfig` stripped `server` down to `{}` on every save; this locks in
   * that it now survives.
   */
  test('writes a self-hosted server for block-kroki, whose config now declares it', async () => {
    blocksModel.definitions = [
      {
        block: 'kroki',
        name: 'Kroki',
        description: 'Draws a diagram through a Kroki server.',
        icon: 'tree-structure',
        config: [{ name: 'server', type: 'string', label: 'Server', default: 'https://kroki.io' }]
      }
    ]

    const [row] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'kroki',
        name: 'Kroki',
        description: 'Draws a diagram through a Kroki server.',
        icon: 'tree-structure',
        isEnabled: true,
        isCustom: false,
        config: {}
      })
      .returning({ id: blocksTable.id })

    const updated = await blocksModel.setBlocksState(fixtures.siteId, [
      { id: row!.id, isEnabled: true, config: { server: 'https://kroki.internal' } }
    ])

    assert.equal(updated, 1)
    const [siteBlock] = (await blocksModel.getSiteBlocks(fixtures.siteId)).filter(
      (b) => b.id === row!.id
    )
    assert.deepEqual(siteBlock!.config, { server: 'https://kroki.internal' })
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

    // -> This describe block's `before()`/`after()` run once for the whole block, so this test shares
    //    its schema and `fixtures.siteId` with every other test here -- an earlier test already left a
    //    'map' row behind. Clear it first so this insert exercises what the test actually means to set
    //    up, instead of colliding with `blocks_composite_idx` on the leftover row.
    await fixtures.db
      .delete(blocksTable)
      .where(and(eq(blocksTable.siteId, fixtures.siteId), eq(blocksTable.block, 'map')))

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

    // -> Same shared-schema reason as the previous test: clear any 'map' row an earlier test in this
    //    describe block left behind before inserting the one this test actually wants to act on.
    await fixtures.db
      .delete(blocksTable)
      .where(and(eq(blocksTable.siteId, fixtures.siteId), eq(blocksTable.block, 'map')))

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

  /**
   * OpenProject #1738: `setBlocksState` deliberately does not queue a re-render of pages that already
   * embed a block moved to disabled here — see the doc comments on this method and on
   * `helpers/htmlSanitizePolicy.ts#blockAllowances` for why. Locks in the actual behavior (no `pageRenderQueue`
   * row, stored `render` left as-is) so neither doc comment can silently drift out of sync with the
   * code again.
   */
  test('disabling a block leaves pages that embed it unqueued and their stored render untouched', async () => {
    blocksModel.definitions = [
      {
        block: 'toggle-propagation-probe',
        name: 'Toggle Propagation Probe',
        description: 'A block used only by this regression test.',
        icon: 'geography'
      }
    ]

    const [block] = await fixtures.db
      .insert(blocksTable)
      .values({
        siteId: fixtures.siteId,
        block: 'toggle-propagation-probe',
        name: 'Toggle Propagation Probe',
        description: 'A block used only by this regression test.',
        icon: 'geography',
        isEnabled: true,
        isCustom: false,
        config: {}
      })
      .returning({ id: blocksTable.id })

    const storedRender =
      '<p>Before</p><block-toggle-propagation-probe lat="1"></block-toggle-propagation-probe><p>After</p>'
    const [page] = await fixtures.db
      .insert(pagesTable)
      .values({
        siteId: fixtures.siteId,
        locale: 'en',
        path: 'toggle-propagation-probe',
        hash: 'toggle-propagation-probe-hash',
        title: 'Toggle Propagation Probe',
        editor: 'markdown',
        contentType: 'markdown',
        content: '::block-toggle-propagation-probe\nlat: 1\n::',
        render: storedRender,
        authorId: fixtures.userId,
        creatorId: fixtures.userId,
        ownerId: fixtures.userId,
        classification: fixtures.classificationId
      })
      .returning({ id: pagesTable.id })

    const updated = await blocksModel.setBlocksState(fixtures.siteId, [
      { id: block!.id, isEnabled: false }
    ])
    assert.equal(updated, 1)

    const queueRows = await fixtures.db
      .select({ id: pageRenderQueueTable.id })
      .from(pageRenderQueueTable)
      .where(eq(pageRenderQueueTable.pageId, page!.id))
    assert.deepEqual(queueRows, [])

    const [pageRow] = await fixtures.db
      .select({ render: pagesTable.render })
      .from(pagesTable)
      .where(eq(pagesTable.id, page!.id))
    assert.equal(pageRow!.render, storedRender)
  })
})

/**
 * `assertValidConfig()`, called from `sanitizeConfig()`, is block-plantuml's own carve-out from the
 * "no per-field validation" rule documented above it: its `server` config is fetched server-side by
 * `DiagramRender#renderPlantuml` (OpenProject task 2223), so a bad value here is not merely a
 * rendering mistake an author would notice — it is refused outright at the point an admin writes it,
 * rather than accepted and only discovered the next time a diagram render tries to reach it.
 */
describe(
  "blocks.setBlocksState validates block-plantuml's server config (DB-backed)",
  {
    skip: !hasTestDatabase()
  },
  () => {
    let fixtures: TestFixtures
    let blocksModel: typeof import('./blocks.ts').blocks

    before(async () => {
      fixtures = await setupTestDb()
      ;({ blocks: blocksModel } = await import('./blocks.ts'))
    })

    after(async () => {
      await teardownTestDb()
    })

    async function insertPlantumlBlock(): Promise<string> {
      blocksModel.definitions = [
        {
          block: 'plantuml',
          name: 'PlantUML',
          description: 'Draws a PlantUML diagram.',
          icon: 'polyline',
          config: [{ name: 'server', type: 'string' }]
        }
      ]
      // -> This describe block's `before()`/`after()` also run once for the whole block, and
      //    `assertValidConfig()` (`models/blocks.ts`) hardcodes the literal block key 'plantuml' to
      //    validate against, so this test's row can't just be renamed per-test the way the other
      //    describe blocks in this file give each test its own unique `block` key. Clear any row a
      //    previous test in here left behind instead, so every call gets a fresh row rather than
      //    colliding with `blocks_composite_idx`.
      await fixtures.db
        .delete(blocksTable)
        .where(and(eq(blocksTable.siteId, fixtures.siteId), eq(blocksTable.block, 'plantuml')))
      const [row] = await fixtures.db
        .insert(blocksTable)
        .values({
          siteId: fixtures.siteId,
          block: 'plantuml',
          name: 'PlantUML',
          description: 'Draws a PlantUML diagram.',
          icon: 'polyline',
          isEnabled: true,
          isCustom: false,
          config: {}
        })
        .returning({ id: blocksTable.id })
      return row!.id
    }

    test('accepts a clean http(s) server URL with no query string or fragment', async () => {
      const id = await insertPlantumlBlock()

      const updated = await blocksModel.setBlocksState(fixtures.siteId, [
        {
          id,
          isEnabled: true,
          config: { server: 'https://plantuml.internal.example.com/plantuml' }
        }
      ])

      assert.equal(updated, 1)
      const [siteBlock] = (await blocksModel.getSiteBlocks(fixtures.siteId)).filter(
        (b) => b.id === id
      )
      assert.deepEqual(siteBlock!.config, {
        server: 'https://plantuml.internal.example.com/plantuml'
      })
    })

    test('accepts an empty server value, the same as leaving it unset', async () => {
      const id = await insertPlantumlBlock()

      const updated = await blocksModel.setBlocksState(fixtures.siteId, [
        { id, isEnabled: true, config: { server: '' } }
      ])

      assert.equal(updated, 1)
    })

    test('refuses a server value that is not a valid URL at all', async () => {
      const id = await insertPlantumlBlock()

      await assert.rejects(
        blocksModel.setBlocksState(fixtures.siteId, [
          { id, isEnabled: true, config: { server: 'not a url' } }
        ]),
        (err: any) => {
          assert.equal(err.name, 'blocksInvalidConfig')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
    })

    test('refuses a non-http(s) server URL', async () => {
      const id = await insertPlantumlBlock()

      await assert.rejects(
        blocksModel.setBlocksState(fixtures.siteId, [
          { id, isEnabled: true, config: { server: 'file:///etc/passwd' } }
        ]),
        (err: any) => {
          assert.equal(err.name, 'blocksInvalidConfig')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
    })

    test('refuses a server URL carrying a query string', async () => {
      const id = await insertPlantumlBlock()

      await assert.rejects(
        blocksModel.setBlocksState(fixtures.siteId, [
          { id, isEnabled: true, config: { server: 'https://plantuml.example.com/plantuml?x=' } }
        ]),
        (err: any) => {
          assert.equal(err.name, 'blocksInvalidConfig')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
    })

    test('refuses a server URL carrying a fragment', async () => {
      const id = await insertPlantumlBlock()

      await assert.rejects(
        blocksModel.setBlocksState(fixtures.siteId, [
          { id, isEnabled: true, config: { server: 'https://plantuml.example.com/plantuml#x' } }
        ]),
        (err: any) => {
          assert.equal(err.name, 'blocksInvalidConfig')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
    })

    test('does not validate an unrelated block\'s "server"-named config field', async () => {
      blocksModel.definitions = [
        {
          block: 'kroki',
          name: 'Kroki',
          description: 'Draws a diagram through a Kroki server.',
          icon: 'polyline',
          config: [{ name: 'server', type: 'string' }]
        }
      ]
      const [row] = await fixtures.db
        .insert(blocksTable)
        .values({
          siteId: fixtures.siteId,
          block: 'kroki',
          name: 'Kroki',
          description: 'Draws a diagram through a Kroki server.',
          icon: 'polyline',
          isEnabled: true,
          isCustom: false,
          config: {}
        })
        .returning({ id: blocksTable.id })

      const updated = await blocksModel.setBlocksState(fixtures.siteId, [
        { id: row!.id, isEnabled: true, config: { server: 'not a url' } }
      ])

      assert.equal(updated, 1, "only block-plantuml's server field is validated")
    })
  }
)
