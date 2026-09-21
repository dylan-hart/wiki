import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { asc, eq } from 'drizzle-orm'
import pagesRoutes from './index.ts'
import { pageHistory as pageHistoryTable, pages as pagesTable } from '../../db/schema.ts'
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
          updatePage: async (siteId: string, id: string, patch: any) => {
            updatePageCalls.push({ siteId, id, patch })
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

    before(async () => {
      await ensureTemporal()
      fixtures = await setupTestDb()
      ;(CARDINAL as any).collab = { pageSaved: () => {} }
      ;({ pages: pagesModel } = await import('../../models/pages.ts'))
      actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
      app = await buildTestApp({
        routes: pagesRoutes,
        schemas: 'all',
        session: () => ({
          authenticated: true,
          user: { id: fixtures.userId },
          groups: [],
          permissions: ['manage:system']
        })
      })
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
