import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import {
  pageHistory as pageHistoryTable,
  pageRenderQueue as pageRenderQueueTable,
  pages as pagesTable,
  tree as treeTable
} from '../db/schema.ts'
import { ALL_PERMISSIONS } from '../helpers/permissions.ts'
import { SITE_PERMISSIONS } from '../helpers/siteRules.ts'
import type { PageActor } from './pages.ts'
import {
  generate,
  isSampleContentAlreadyGenerated,
  purge,
  SAMPLE_CONTENT_PATH_PREFIX,
  SAMPLE_CONTENT_TAG,
  SAMPLE_PAGES
} from './sampleContent.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

function realMcpToolNames(): Set<string> {
  const toolsDir = path.join(REPO_ROOT, 'backend/mcp/tools')
  const names = new Set<string>()
  for (const entry of fs.readdirSync(toolsDir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) {
      continue
    }
    const match = fs
      .readFileSync(path.join(toolsDir, entry), 'utf8')
      .match(/server\.registerTool\(\s*'([a-z_]+)'/)
    if (match) {
      names.add(match[1]!)
    }
  }
  return names
}

describe('the Welcome sample page set', () => {
  test('every page has a unique path under the reserved prefix', () => {
    const paths = SAMPLE_PAGES.map((sample) => sample.path)
    assert.equal(new Set(paths).size, paths.length)
    for (const samplePath of paths) {
      assert.ok(samplePath.startsWith(SAMPLE_CONTENT_PATH_PREFIX), samplePath)
      assert.ok(samplePath.length > SAMPLE_CONTENT_PATH_PREFIX.length, samplePath)
    }
  })

  test('every page has a title and non-empty content', () => {
    for (const sample of SAMPLE_PAGES) {
      assert.ok(sample.title.trim().length > 0, sample.path)
      assert.ok(sample.content.trim().length > 0, sample.path)
    }
  })

  test('page tags are lower-case, and the reserved tag is left for generate() to add', () => {
    for (const sample of SAMPLE_PAGES) {
      for (const tag of sample.tags) {
        assert.equal(tag, tag.toLowerCase(), sample.path)
        assert.notEqual(tag, SAMPLE_CONTENT_TAG, sample.path)
      }
    }
  })

  test('every ::block-* container names a block that exists and is closed', () => {
    let openers = 0
    for (const sample of SAMPLE_PAGES) {
      const opened = [...sample.content.matchAll(/^(:{2,})block-([a-z0-9-]+)/gm)]
      const closed = [...sample.content.matchAll(/^:{2,}$/gm)]
      assert.equal(opened.length, closed.length, `${sample.path} leaves a block unclosed`)
      for (const [, , name] of opened) {
        openers++
        assert.ok(
          fs.existsSync(path.join(REPO_ROOT, 'blocks', `block-${name}`, 'component.js')),
          `${sample.path} uses ::block-${name}, which does not exist in blocks/`
        )
      }
    }
    assert.ok(openers > 0, 'expected the set to demonstrate at least one block')
  })

  test('code fences are balanced', () => {
    for (const sample of SAMPLE_PAGES) {
      const fences = sample.content.match(/^```/gm) ?? []
      assert.equal(fences.length % 2, 0, sample.path)
    }
  })

  test('every permission name a page mentions exists', () => {
    const known = new Set<string>([...ALL_PERMISSIONS, ...SITE_PERMISSIONS])
    let mentioned = 0
    for (const sample of SAMPLE_PAGES) {
      const names = sample.content.matchAll(
        /`((?:access|read|write|manage|delete|review|publish|site):[a-z-]+)`/g
      )
      for (const [, name] of names) {
        mentioned++
        assert.ok(known.has(name!), `${sample.path} mentions unknown permission ${name}`)
      }
    }
    assert.ok(mentioned > 0)
  })

  test('every MCP tool a page mentions is registered', () => {
    const tools = realMcpToolNames()
    assert.ok(tools.size > 0)
    let mentioned = 0
    for (const sample of SAMPLE_PAGES) {
      for (const [, name] of sample.content.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        mentioned++
        assert.ok(tools.has(name!), `${sample.path} mentions unknown MCP tool ${name}`)
      }
    }
    assert.ok(mentioned > 0)
  })

  test('every internal link points at another page in the set', () => {
    const paths = new Set(SAMPLE_PAGES.map((sample) => sample.path))
    for (const sample of SAMPLE_PAGES) {
      for (const [, target] of sample.content.matchAll(/\]\(\/([^)#\s]+)\)/g)) {
        assert.ok(
          paths.has(target!),
          `${sample.path} links to /${target}, which is not sample content`
        )
      }
    }
  })

  test('the landing page links to every other page', () => {
    const [landing, ...others] = SAMPLE_PAGES
    for (const other of others) {
      assert.ok(landing!.content.includes(`](/${other.path})`), `landing page misses ${other.path}`)
    }
  })

  test('the set covers the topics the tour promises', () => {
    const paths = SAMPLE_PAGES.map((sample) => sample.path).join('\n')
    for (const topic of ['page-rules', 'approvals', 'classified', 'glossary', 'diagram', 'mcp']) {
      assert.match(paths, new RegExp(topic))
    }
  })
})

describe('sample content generate and purge (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  beforeEach(async () => {
    await fixtures.db.delete(pagesTable)
    await fixtures.db.delete(treeTable)
  })

  async function createPlainPage(path: string, tags: string[]) {
    return CARDINAL.models.pages.createPage(
      fixtures.siteId,
      { path, title: `Page ${path}`, editor: 'markdown', content: '# Body', tags },
      actor
    )
  }

  async function allPaths(): Promise<string[]> {
    const rows = await fixtures.db.select({ path: pagesTable.path }).from(pagesTable)
    return rows.map((row) => row.path).sort()
  }

  test('the reserved constants and page list are consistent', () => {
    assert.ok(SAMPLE_PAGES.length >= 1)
    for (const sample of SAMPLE_PAGES) {
      assert.ok(sample.path.startsWith(SAMPLE_CONTENT_PATH_PREFIX))
    }
  })

  test('generate creates every sample page, marked with the reserved tag', async () => {
    const result = await generate(fixtures.siteId, actor)

    assert.equal(result.created, SAMPLE_PAGES.length)
    assert.deepEqual(result.paths.sort(), SAMPLE_PAGES.map((sample) => sample.path).sort())

    const rows = await fixtures.db.select().from(pagesTable)
    assert.equal(rows.length, SAMPLE_PAGES.length)
    for (const row of rows) {
      assert.ok(row.path.startsWith(SAMPLE_CONTENT_PATH_PREFIX))
      assert.ok(row.tags.includes(SAMPLE_CONTENT_TAG))
      assert.equal(row.siteId, fixtures.siteId)
    }
  })

  test('every generated page is accepted by the render queue', async () => {
    const result = await generate(fixtures.siteId, actor)

    const pageRows = await fixtures.db.select().from(pagesTable)
    assert.equal(pageRows.length, SAMPLE_PAGES.length)
    const queued = await fixtures.db
      .select({ pageId: pageRenderQueueTable.pageId })
      .from(pageRenderQueueTable)
      .where(eq(pageRenderQueueTable.siteId, fixtures.siteId))
    assert.deepEqual(queued.map((row) => row.pageId).sort(), pageRows.map((row) => row.id).sort())
    assert.equal(result.created, SAMPLE_PAGES.length)
    for (const row of pageRows) {
      assert.equal(row.editor, 'markdown')
      assert.ok((row.content ?? '').trim().length > 0)
    }
  })

  test('generate goes through createPage, so tree and history rows exist', async () => {
    await generate(fixtures.siteId, actor)

    const rows = await fixtures.db.select().from(pagesTable)
    for (const row of rows) {
      const tree = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, row.id))
      assert.equal(tree.length, 1)
      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, row.id))
      assert.equal(history.length, 1)
      assert.equal(history[0]!.action, 'created')
    }
  })

  test('generate refuses with a distinguishable error when sample content already exists', async () => {
    await generate(fixtures.siteId, actor)
    const before = await allPaths()

    await assert.rejects(generate(fixtures.siteId, actor), (err: any) => {
      assert.equal(isSampleContentAlreadyGenerated(err), true)
      assert.equal(err.statusCode, 409)
      return true
    })
    assert.deepEqual(await allPaths(), before)
  })

  test('an unrelated error is not reported as already generated', () => {
    assert.equal(isSampleContentAlreadyGenerated(new Error('boom')), false)
    assert.equal(isSampleContentAlreadyGenerated(undefined), false)
  })

  test('generate surfaces the duplicate-path error instead of overwriting a real page', async () => {
    const samplePath = SAMPLE_PAGES[0]!.path
    const real = await createPlainPage(samplePath, ['docs'])

    await assert.rejects(generate(fixtures.siteId, actor), (err: any) => {
      assert.equal(err.name, 'pageDuplicatePath')
      assert.equal(isSampleContentAlreadyGenerated(err), false)
      return true
    })

    const rows = await fixtures.db.select().from(pagesTable)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, real.id)
    assert.deepEqual(rows[0]!.tags, ['docs'])
  })

  test('purge removes the generated pages and their tree entries', async () => {
    await generate(fixtures.siteId, actor)

    const result = await purge(fixtures.siteId, actor)

    assert.deepEqual(result, { found: SAMPLE_PAGES.length, deleted: SAMPLE_PAGES.length })
    assert.deepEqual(await allPaths(), [])
    const pageTreeRows = await fixtures.db
      .select()
      .from(treeTable)
      .where(eq(treeTable.type, 'page'))
    assert.equal(pageTreeRows.length, 0)
  })

  test('purge leaves hand-tagged and partially marked pages untouched', async () => {
    await generate(fixtures.siteId, actor)
    const handTagged = await createPlainPage('notes/hand-tagged', ['test'])
    const tagOnly = await createPlainPage('notes/tag-only', [SAMPLE_CONTENT_TAG])
    const prefixOnly = await createPlainPage(`${SAMPLE_CONTENT_PATH_PREFIX}my-own-page`, ['docs'])
    const prefixWithTest = await createPlainPage(`${SAMPLE_CONTENT_PATH_PREFIX}my-test-page`, [
      'test'
    ])

    const result = await purge(fixtures.siteId, actor)

    assert.deepEqual(result, { found: SAMPLE_PAGES.length, deleted: SAMPLE_PAGES.length })
    const remaining = await fixtures.db.select({ id: pagesTable.id }).from(pagesTable)
    assert.deepEqual(
      remaining.map((row) => row.id).sort(),
      [handTagged.id, tagOnly.id, prefixOnly.id, prefixWithTest.id].sort()
    )
  })

  test('a page that carries the reserved tag outside the prefix is never purged', async () => {
    const outside = await createPlainPage('elsewhere/welcome/page', [SAMPLE_CONTENT_TAG])
    const lookalike = await createPlainPage('welcomes/page', [SAMPLE_CONTENT_TAG])

    const result = await purge(fixtures.siteId, actor)

    assert.deepEqual(result, { found: 0, deleted: 0 })
    const remaining = await fixtures.db.select({ id: pagesTable.id }).from(pagesTable)
    assert.deepEqual(remaining.map((row) => row.id).sort(), [outside.id, lookalike.id].sort())
  })

  test('purge with nothing to remove reports zero counts', async () => {
    assert.deepEqual(await purge(fixtures.siteId, actor), { found: 0, deleted: 0 })
  })

  test('generate works again after a purge', async () => {
    await generate(fixtures.siteId, actor)
    await purge(fixtures.siteId, actor)

    const result = await generate(fixtures.siteId, actor)

    assert.equal(result.created, SAMPLE_PAGES.length)
    assert.deepEqual(await allPaths(), SAMPLE_PAGES.map((sample) => sample.path).sort())
  })
})
