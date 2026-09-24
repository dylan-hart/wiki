import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { asc, eq } from 'drizzle-orm'
import pagesRoutes from './index.ts'
import {
  groups as groupsTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable
} from '../../db/schema.ts'
import { CustomError } from '../../helpers/common.ts'
import type { PageActor } from '../../models/pages.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'

const CONTENT = '# Todo\n\n```\n- [ ] fenced\n```\n\n- [ ] one\n- [x] two\n- [ ] three\n'
const RENDER =
  '<h1>Todo</h1><pre><code>- [ ] fenced\n</code></pre>' +
  '<ul class="contains-task-list">' +
  '<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> one</li>' +
  '<li class="task-list-item"><input class="task-list-item-checkbox" checked="" disabled="" type="checkbox"> two</li>' +
  '<li class="task-list-item"><input class="task-list-item-checkbox" disabled="" type="checkbox"> three</li>' +
  '</ul>'

describe('PUT /sites/:siteId/pages/:pageId/tasks/:index', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const UPDATED_AT = new Date('2026-09-21T12:00:00.123Z')

  let updatePageCalls: any[] = []
  let updatePageImpl: (() => Promise<any>) | null
  let grantedPermissions: Set<string>
  let pageOverrides: Record<string, unknown>
  let app: FastifyInstance

  before(async () => {
    await ensureTemporal()
    const wiki = {
      models: {
        pages: {
          getPage: async ({ id }: { id: string }) =>
            id === PAGE_ID
              ? {
                  id: PAGE_ID,
                  path: 'todo',
                  locale: 'en',
                  classification: null,
                  tags: [],
                  contentType: 'markdown',
                  isLocked: false,
                  content: CONTENT,
                  render: RENDER,
                  authorName: 'Someone',
                  updatedAt: UPDATED_AT,
                  ...pageOverrides
                }
              : null,
          updatePage: async (
            siteId: string,
            id: string,
            patch: any,
            _actor: unknown,
            options: unknown
          ) => {
            updatePageCalls.push({ siteId, id, patch, options })
            if (updatePageImpl) {
              return updatePageImpl()
            }
            return { id, authorName: 'Someone', updatedAt: new Date('2026-09-21T12:05:00.456Z') }
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          groupIdsForRequest: () => [],
          checkAccess: (_actor: unknown, permission: string) => grantedPermissions.has(permission)
        }
      },
      sites: { [SITE_ID]: {} },
      collab: { pageSaved: () => {} }
    }
    app = await buildTestApp({ routes: pagesRoutes, wiki, session: 'header', schemas: 'all' })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    updatePageCalls = []
    updatePageImpl = null
    grantedPermissions = new Set(['read:pages', 'write:pages'])
    pageOverrides = {}
  })

  const sessionHeader = {
    'x-test-session': JSON.stringify({
      authenticated: true,
      user: { id: 'user-1' },
      permissions: []
    })
  }

  function tick(
    index: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = sessionHeader
  ) {
    return app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/tasks/${index}`,
      headers,
      payload: { checked: true, text: 'one', expectedUpdatedAt: UPDATED_AT.toISOString(), ...body }
    })
  }

  test('flips one marker in the source and the matching checkbox in the render, with no re-render queued', async () => {
    const res = await tick(0, {})
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().updatedAt, '2026-09-21T12:05:00.456Z')
    assert.equal(updatePageCalls.length, 1)
    const { patch } = updatePageCalls[0]
    assert.deepEqual(Object.keys(patch).sort(), ['content', 'render'])
    assert.equal(patch.content, CONTENT.replace('- [ ] one', '- [x] one'))
    assert.equal(
      patch.render,
      RENDER.replace(
        '<input class="task-list-item-checkbox" disabled="" type="checkbox"> one',
        '<input class="task-list-item-checkbox" disabled="" type="checkbox" checked=""> one'
      )
    )
  })

  test('writes the render as a stored-render patch, conditional on the updatedAt it read', async () => {
    const res = await tick(0, {})
    assert.equal(res.statusCode, 200)
    assert.deepEqual(updatePageCalls[0].options, {
      storedRenderPatch: true,
      expectedUpdatedAt: UPDATED_AT
    })
  })

  test('rewrites only that checkbox tag, leaving every other byte of the render as stored', async () => {
    const render =
      '<p title=\'x\'>A &amp; B<br></p><ul><li><input class="task-list-item-checkbox" type="checkbox" disabled> one</li></ul>' +
      '<iframe src="https://example.com/embed"></iframe><script>if (a < b) {}</script>'
    pageOverrides = { content: '- [ ] one\n', render }
    const res = await tick(0, {})
    assert.equal(res.statusCode, 200)
    assert.equal(
      updatePageCalls[0].patch.render,
      render.replace(
        '<input class="task-list-item-checkbox" type="checkbox" disabled>',
        '<input class="task-list-item-checkbox" type="checkbox" disabled="" checked="">'
      )
    )
  })

  test('answers 409 with the page’s new updatedAt when another save lands before the write', async () => {
    updatePageImpl = async () => {
      pageOverrides = { updatedAt: new Date('2026-09-21T12:01:00.789Z') }
      throw new CustomError(
        'pageChangedSinceLoad',
        'This page was changed since you loaded it.',
        409
      )
    }
    const res = await tick(0, {})
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().updatedAt, '2026-09-21T12:01:00.789Z')
  })

  test('unticks by removing the checked attribute of that checkbox only', async () => {
    const res = await tick(1, { checked: false, text: 'two' })
    assert.equal(res.statusCode, 200)
    const { patch } = updatePageCalls[0]
    assert.equal(patch.content, CONTENT.replace('- [x] two', '- [ ] two'))
    assert.equal(patch.render, RENDER.replace(' checked=""', ''))
  })

  test('a task inside a fenced block is not an item: its text is refused', async () => {
    const res = await tick(0, { text: 'fenced' })
    assert.equal(res.statusCode, 409)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 403 without write:pages', async () => {
    grantedPermissions = new Set(['read:pages'])
    const res = await tick(0, {})
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 404 for a page the caller cannot read', async () => {
    grantedPermissions = new Set(['write:pages'])
    const res = await tick(0, {})
    assert.equal(res.statusCode, 404)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 401 to an anonymous caller', async () => {
    const res = await tick(0, {}, {})
    assert.equal(res.statusCode, 401)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 403 for a page that is still locked', async () => {
    pageOverrides = { isLocked: true }
    const res = await tick(0, {})
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 409 with the current updatedAt when expectedUpdatedAt is stale', async () => {
    const res = await tick(0, { expectedUpdatedAt: '2026-09-21T11:00:00.000Z' })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().updatedAt, '2026-09-21T12:00:00.123Z')
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 409 when the text at that ordinal differs', async () => {
    const res = await tick(0, { text: 'something else' })
    assert.equal(res.statusCode, 409)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 409 for an ordinal past the last item', async () => {
    const res = await tick(3, { text: 'one' })
    assert.equal(res.statusCode, 409)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 409 when the stored render no longer has the source’s checkboxes', async () => {
    pageOverrides = { render: '<p>stale</p>' }
    const res = await tick(0, {})
    assert.equal(res.statusCode, 409)
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 200 and writes nothing when the item is already in that state', async () => {
    const res = await tick(1, { text: 'two' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().updatedAt, '2026-09-21T12:00:00.123Z')
    assert.equal(updatePageCalls.length, 0)
  })

  test('answers 400 for a page that is not markdown', async () => {
    pageOverrides = { contentType: 'html' }
    const res = await tick(0, {})
    assert.equal(res.statusCode, 400)
    assert.equal(updatePageCalls.length, 0)
  })

  test('rejects a body missing expectedUpdatedAt and a negative ordinal', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/tasks/0`,
      headers: sessionHeader,
      payload: { checked: true, text: 'one' }
    })
    assert.equal(missing.statusCode, 400)
    const negative = await tick(-1, {})
    assert.equal(negative.statusCode, 400)
  })
})

describe(
  'PUT /sites/:siteId/pages/:pageId/tasks/:index (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let app: FastifyInstance
    let pagesModel: typeof import('../../models/pages.ts').pages
    let actor: PageActor
    let testSession: any

    const asAdmin = () => {
      testSession = {
        authenticated: true,
        user: { id: fixtures.userId },
        groups: [],
        permissions: ['manage:system']
      }
    }

    before(async () => {
      await ensureTemporal()
      fixtures = await setupTestDb()
      ;(CARDINAL as any).collab = { pageSaved: () => {} }
      ;({ pages: pagesModel } = await import('../../models/pages.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
      app = await buildTestApp({
        routes: pagesRoutes,
        schemas: 'all',
        session: () => testSession
      })
    })

    beforeEach(asAdmin)

    const tickPage = (page: { id: string; updatedAt: Date }, index: number, text: string) =>
      app.inject({
        method: 'PUT',
        url: `/sites/${fixtures.siteId}/pages/${page.id}/tasks/${index}`,
        payload: {
          checked: true,
          text,
          expectedUpdatedAt: page.updatedAt
            .toTemporalInstant()
            .toString({ smallestUnit: 'millisecond' })
        }
      })

    const storedRow = async (id: string) =>
      (await fixtures.db.select().from(pagesTable).where(eq(pagesTable.id, id)).limit(1))[0]!

    test('a tick by a writer without write:scripts keeps the embed the page’s author was allowed', async () => {
      const embed =
        '<iframe src="https://example.com/embed"></iframe><script>window.ticked = 1</script>'
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'todo/embed',
          title: 'Embed',
          editor: 'markdown',
          content: CONTENT,
          render: RENDER + embed
        },
        actor
      )
      const stored = await storedRow(page.id)
      assert.ok(stored.render!.includes('<iframe'), 'the author may embed, so the fixture must')
      assert.ok(stored.render!.includes('<script'), 'the author may embed, so the fixture must')

      const [writers] = await fixtures.db
        .insert(groupsTable)
        .values({
          name: 'Todo writers',
          permissions: [],
          rules: [
            {
              id: 'todo-writers',
              name: 'Write todo',
              roles: ['read:pages', 'write:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: 'todo',
              locales: [],
              sites: []
            }
          ]
        })
        .returning({ id: groupsTable.id })
      await CARDINAL.models.groups.reloadCache()
      testSession = {
        authenticated: true,
        user: { id: fixtures.userId },
        groups: [writers!.id],
        permissions: []
      }

      const res = await tickPage(page, 0, 'one')
      assert.equal(res.statusCode, 200)

      const after = await storedRow(page.id)
      assert.equal(after.content, CONTENT.replace('- [ ] one', '- [x] one'))
      assert.equal(after.render!.split('checked=""').length - 1, 2)
      assert.equal(
        after.render!.replace(/ checked=""/g, ''),
        stored.render!.replace(/ checked=""/g, '')
      )
      assert.ok(!after.render!.includes('requires the write:scripts permission'))
    })

    test('a tick racing another save of the page answers 409 and does not overwrite that save', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'todo/race', title: 'Race', editor: 'markdown', content: CONTENT, render: RENDER },
        actor
      )
      const concurrent = CONTENT.replace('- [ ] three', '- [x] three')
      const concurrentAt = new Date(page.updatedAt.getTime() + 1000)
      const original = pagesModel.updatePage.bind(pagesModel)
      const updatePage = mock.method(
        pagesModel,
        'updatePage',
        async (...args: Parameters<typeof original>) => {
          // -> Another tick of the same page, landing after this request read the page and before
          //    it writes: both passed the `expectedUpdatedAt` check against the same row.
          await fixtures.db
            .update(pagesTable)
            .set({ content: concurrent, updatedAt: concurrentAt })
            .where(eq(pagesTable.id, page.id))
          return original(...args)
        }
      )
      try {
        const res = await tickPage(page, 0, 'one')
        assert.equal(res.statusCode, 409)
        assert.equal(res.json().updatedAt, concurrentAt.toISOString())
      } finally {
        updatePage.mock.restore()
      }
      assert.equal((await storedRow(page.id)).content, concurrent)

      const second = await tickPage(page, 0, 'one')
      assert.equal(second.statusCode, 409, 'the same stale view is refused on retry too')
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    test('a tick stores a new pageHistory version differing only in that marker, and queues no re-render', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'todo/tick', title: 'Tick', editor: 'markdown', content: CONTENT, render: RENDER },
        actor
      )
      const before = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)

      const res = await app.inject({
        method: 'PUT',
        url: `/sites/${fixtures.siteId}/pages/${page.id}/tasks/0`,
        payload: {
          checked: true,
          text: 'one',
          expectedUpdatedAt: page.updatedAt
            .toTemporalInstant()
            .toString({ smallestUnit: 'millisecond' })
        }
      })
      assert.equal(res.statusCode, 200)

      const after = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, page.id))
        .limit(1)
      assert.equal(after[0]!.content, CONTENT.replace('- [ ] one', '- [x] one'))
      assert.equal(after[0]!.render!.split('checked=""').length - 1, 2)
      assert.equal(after[0]!.searchContent, before[0]!.searchContent)

      const history = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, page.id))
        .orderBy(asc(pageHistoryTable.versionDate))
      assert.equal(history.length, 2)
      const [previous, latest] = history
      assert.equal(
        latest!.content!.replace('- [x] one', '- [ ] one'),
        previous!.content!.replace('- [x] one', '- [ ] one')
      )
      assert.notEqual(latest!.content, previous!.content)
      assert.deepEqual(
        [previous!.content, latest!.content].map((content) => content!.split('- [x]').length - 1),
        [1, 2]
      )
    })
  }
)
