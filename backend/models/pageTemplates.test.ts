import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { installTestWiki } from '../test/mocks.ts'
import { pageTemplates } from './pageTemplates.ts'

const NONE = { scripts: false, styles: false }

describe('pageTemplates.sanitizeContent (pure)', () => {
  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({
      sites: { 'site-1': { config: {} } },
      models: {
        blocks: {
          definitions: [],
          getEnabledKeys: async () => new Set<string>(),
          getCustomBlockDefinitions: async () => []
        }
      }
    })
  })

  after(() => wiki.restore())

  const clean = (content: string, editor = 'markdown', permissions = NONE) =>
    pageTemplates.sanitizeContent('site-1', content, editor, permissions)

  test('markdown source keeps its > < & and entities untouched', async () => {
    const source =
      '# Title\n\n> quote & more &amp; less\n\nif a < b && c > d\n\n```js\nx => x\n```\n'
    assert.equal(await clean(source), source)
  })

  test('a script tag is stripped without the permission and survives with it', async () => {
    const source = 'before\n\n<script>alert(1)</script>\n\nafter'
    assert.ok(!(await clean(source)).includes('<script'))
    assert.ok(
      (await clean(source, 'markdown', { scripts: true, styles: false })).includes('<script')
    )
  })

  test('an inline event handler is stripped without write:scripts', async () => {
    const out = await clean('<b onclick="x()">bold</b>')
    assert.ok(out.includes('<b>bold</b>'))
    assert.ok(!out.includes('onclick'))
  })

  test('a style tag needs write:styles', async () => {
    const source = '<style>p { color: red }</style>'
    assert.ok(!(await clean(source)).includes('<style'))
    assert.ok(
      (await clean(source, 'markdown', { scripts: false, styles: true })).includes('<style')
    )
  })

  test('a query-string ampersand inside an attribute is preserved', async () => {
    const out = await clean('<a href="https://example.com/?a=1&b=2">x</a>')
    assert.ok(out.includes('a=1&b=2'))
  })

  test('the code editor is sanitized as HTML', async () => {
    const out = await clean('<p onclick="x()">a &amp; b</p><script>1</script>', 'code')
    assert.equal(out, '<p>a &amp; b</p>')
  })
})

describe('pageTemplates (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
    const wiki = (globalThis as any).CARDINAL
    wiki.models.blocks.definitions ??= []
    wiki.models.blocks.getEnabledKeys = async () => new Set<string>()
    wiki.models.blocks.getCustomBlockDefinitions = async () => []
    wiki.sites[fixtures.siteId].config = {
      ...wiki.sites[fixtures.siteId].config,
      locales: { primary: 'en', active: ['en', 'fr'] }
    }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('create, get, update and delete round-trip', async () => {
    const created = await pageTemplates.create(
      fixtures.siteId,
      { name: 'Runbook', description: ' ops ', content: '# Steps' },
      fixtures.userId,
      NONE
    )
    assert.equal(created.name, 'Runbook')
    assert.equal(created.description, 'ops')
    assert.equal(created.editor, 'markdown')
    assert.equal(created.locale, null)
    assert.equal(created.createdBy, fixtures.userId)

    const updated = await pageTemplates.update(
      fixtures.siteId,
      created.id,
      { name: 'Runbook v2', content: '# Steps\n\n<script>x</script>' },
      NONE
    )
    assert.equal(updated.name, 'Runbook v2')
    assert.equal(updated.content.includes('<script'), false)
    assert.equal(updated.description, 'ops')

    assert.equal((await pageTemplates.get(fixtures.siteId, created.id))?.name, 'Runbook v2')
    await pageTemplates.delete(fixtures.siteId, created.id)
    assert.equal(await pageTemplates.get(fixtures.siteId, created.id), null)
    await assert.rejects(pageTemplates.delete(fixtures.siteId, created.id), { statusCode: 404 })
  })

  test('list by locale returns the all-locale templates plus that locale’s own', async () => {
    const all = await pageTemplates.create(fixtures.siteId, { name: 'A all' }, null, NONE)
    const fr = await pageTemplates.create(
      fixtures.siteId,
      { name: 'B fr', locale: 'fr' },
      null,
      NONE
    )
    try {
      const french = await pageTemplates.list(fixtures.siteId, 'fr')
      assert.deepEqual(
        french.map((t) => t.name),
        ['A all', 'B fr']
      )
      const english = await pageTemplates.list(fixtures.siteId, 'en')
      assert.deepEqual(
        english.map((t) => t.name),
        ['A all']
      )
      assert.equal((await pageTemplates.list(fixtures.siteId)).length, 2)
    } finally {
      await pageTemplates.delete(fixtures.siteId, all.id)
      await pageTemplates.delete(fixtures.siteId, fr.id)
    }
  })

  test('names are unique per site and locale, ignoring case, including the all-locale scope', async () => {
    const first = await pageTemplates.create(fixtures.siteId, { name: 'Dup' }, null, NONE)
    try {
      await assert.rejects(pageTemplates.create(fixtures.siteId, { name: 'dup' }, null, NONE), {
        statusCode: 409
      })
      const scoped = await pageTemplates.create(
        fixtures.siteId,
        { name: 'dup', locale: 'fr' },
        null,
        NONE
      )
      await pageTemplates.delete(fixtures.siteId, scoped.id)
    } finally {
      await pageTemplates.delete(fixtures.siteId, first.id)
    }
  })

  test('an empty name, an unknown editor and an inactive locale are 400s', async () => {
    await assert.rejects(pageTemplates.create(fixtures.siteId, { name: '  ' }, null, NONE), {
      statusCode: 400
    })
    await assert.rejects(
      pageTemplates.create(fixtures.siteId, { name: 'X', editor: 'redirect' }, null, NONE),
      { statusCode: 400 }
    )
    await assert.rejects(
      pageTemplates.create(fixtures.siteId, { name: 'X', locale: 'de' }, null, NONE),
      { statusCode: 400 }
    )
  })

  test('updating a template that does not exist is a 404', async () => {
    await assert.rejects(
      pageTemplates.update(
        fixtures.siteId,
        '00000000-0000-4000-8000-000000000000',
        { name: 'X' },
        NONE
      ),
      { statusCode: 404 }
    )
  })
})
