import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { groups as groupsTable } from '../db/schema.ts'
import type { GroupRule } from '../models/groups.ts'
import type { PageActor } from '../models/pages.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { parseTaskItems } from '../helpers/taskItems.ts'
import tasksRoutes from './tasks.ts'

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('GET /sites/:siteId/tasks (stubbed model)', () => {
  let app: FastifyInstance
  let calls: Array<Record<string, any>>

  before(async () => {
    await ensureTemporal()
    const wiki = {
      data: { systemIds: { guestsGroupId: 'guests' } },
      models: {
        groups: {
          actorForRequest: () => ({ permissions: [], groupIds: [] }),
          groupIdsForRequest: () => [],
          checkAccess: () => false
        },
        tasks: {
          async listOpenTasks(params: Record<string, any>) {
            calls.push(params)
            return {
              results: [
                {
                  pageId: '11111111-1111-4111-8111-111111111111',
                  path: 'docs/one',
                  locale: 'en',
                  title: 'One',
                  tags: ['a'],
                  updatedAt: new Date('2026-06-01T00:00:00.123Z'),
                  items: [{ index: 1, text: 'do it', line: 4 }]
                }
              ],
              totalHits: 1,
              totalItems: 1
            }
          }
        }
      }
    }
    app = await buildTestApp({ routes: tasksRoutes, ajv: true, wiki, session: 'header' })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    calls = []
  })

  test('serialises pages with their items and totals', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/tasks` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      results: [
        {
          pageId: '11111111-1111-4111-8111-111111111111',
          path: 'docs/one',
          locale: 'en',
          title: 'One',
          tags: ['a'],
          updatedAt: '2026-06-01T00:00:00.123Z',
          items: [{ index: 1, text: 'do it', line: 4 }]
        }
      ],
      totalHits: 1,
      totalItems: 1
    })
  })

  test('forwards the filters and treats a caller with no session as public-only', async () => {
    await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/tasks?tag=a,b&folder=docs&offset=5&limit=10`
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.siteId, SITE_ID)
    assert.deepEqual(calls[0]!.tags, ['a', 'b'])
    assert.equal(calls[0]!.folder, 'docs')
    assert.equal(calls[0]!.offset, 5)
    assert.equal(calls[0]!.limit, 10)
    assert.equal(calls[0]!.publicOnly, true)
  })

  test('a logged in caller is not public-only', async () => {
    await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/tasks`,
      headers: {
        'x-test-session': JSON.stringify({
          authenticated: true,
          user: { id: '22222222-2222-4222-8222-222222222222' },
          permissions: [],
          groups: []
        })
      }
    })
    assert.equal(calls[0]!.publicOnly, false)
    assert.deepEqual(calls[0]!.tags, [])
  })

  test('rejects a limit above the maximum', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/tasks?limit=1000` })
    assert.equal(res.statusCode, 400)
  })
})

describe('GET /sites/:siteId/tasks (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let app: FastifyInstance
  let groupsModel: typeof import('../models/groups.ts').groups
  let pagesModel: typeof import('../models/pages.ts').pages
  let testSession: any = null
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('../models/groups.ts'))
    ;({ pages: pagesModel } = await import('../models/pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    app = await buildTestApp({ routes: tasksRoutes, session: () => testSession })

    const content = (label: string) =>
      `- [ ] open ${label}\n- [x] done ${label}\n- [ ] second ${label}\n`
    const create = (path: string, extra: Record<string, any> = {}, body = content(path)) =>
      pagesModel.createPage(
        fixtures.siteId,
        {
          path,
          title: path,
          editor: 'markdown',
          content: body,
          publishState: 'published',
          ...extra
        },
        actor
      )

    await create('team/alpha', { tags: ['sprint'] })
    await create('team/beta', { tags: ['other'] })
    await create('team/locked', { tags: ['sprint'], password: 'hunter2' })
    await create('secret/plans', { tags: ['sprint'] })
    await create('team/finished', {}, '- [x] all done\n')
    await create('team/fenced', {}, '```\n- [ ] not a task\n```\n')
    await create('teamwork/other')

    const rule: GroupRule = {
      id: 'rule-1',
      name: 'Read team',
      roles: ['read:pages'],
      match: 'SUBTREE',
      mode: 'ALLOW',
      path: 'team',
      locales: [],
      sites: []
    }
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  const asReader = () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [fixtures.groupId],
      permissions: []
    }
  }

  const get = async (query = '') => {
    const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/tasks${query}` })
    assert.equal(res.statusCode, 200)
    return res.json() as {
      results: Array<{ path: string; items: Array<{ index: number; text: string }> }>
      totalHits: number
      totalItems: number
    }
  }

  test('an unreadable page and a password-locked page contribute no items', async () => {
    asReader()
    const body = await get()
    assert.deepEqual(
      body.results.map((page) => page.path),
      ['team/alpha', 'team/beta']
    )
    assert.equal(body.totalHits, 2)
    assert.equal(body.totalItems, 4)
  })

  test('lists only unchecked items, numbered as the tick route numbers them', async () => {
    asReader()
    const body = await get()
    const alpha = body.results.find((page) => page.path === 'team/alpha')!
    assert.deepEqual(
      alpha.items.map((item) => item.index),
      [0, 2]
    )
    assert.deepEqual(
      parseTaskItems('- [ ] open team/alpha\n- [x] done team/alpha\n- [ ] second team/alpha\n')
        .filter((item) => !item.checked)
        .map((item) => item.index),
      [0, 2]
    )
  })

  test('the tag filter narrows the result', async () => {
    asReader()
    const body = await get('?tag=sprint')
    assert.deepEqual(
      body.results.map((page) => page.path),
      ['team/alpha']
    )
  })

  test('the folder filter narrows the result and does not match a sibling prefix', async () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: ['manage:system']
    }
    const body = await get('?folder=team')
    assert.ok(body.results.length > 0)
    assert.ok(body.results.every((page) => page.path.startsWith('team/')))
    assert.ok(!body.results.some((page) => page.path === 'teamwork/other'))
  })

  test('a caller who may bypass the password sees the locked page', async () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: ['manage:system']
    }
    const body = await get('?folder=team')
    assert.ok(body.results.some((page) => page.path === 'team/locked'))
  })

  test('an item’s source is returned only to a caller who may read the page’s source', async () => {
    const source =
      'call <!-- the real number is 555 --> <span data-note="secret">Bob</span> **now**'
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'desk/sources',
        title: 'Sources',
        editor: 'markdown',
        content: `- [ ] ${source}\n`,
        publishState: 'published'
      },
      actor
    )
    const rule = (roles: string[]): GroupRule => ({
      id: `desk-${roles.join('-')}`,
      name: 'Desk',
      roles,
      match: 'SUBTREE',
      mode: 'ALLOW',
      path: 'desk',
      locales: [],
      sites: []
    })
    const groupFor = async (name: string, roles: string[]) => {
      const [group] = await fixtures.db
        .insert(groupsTable)
        .values({ name, permissions: [], rules: [rule(roles)] })
        .returning({ id: groupsTable.id })
      return group!.id
    }
    const readers = await groupFor('Desk readers', ['read:pages'])
    const sourceReaders = await groupFor('Desk source readers', ['read:pages', 'read:source'])
    const writers = await groupFor('Desk writers', ['read:pages', 'write:pages'])
    await groupsModel.reloadCache()

    const itemTextAs = async (groupId: string) => {
      testSession = {
        authenticated: true,
        user: { id: fixtures.userId },
        groups: [groupId],
        permissions: []
      }
      const body = await get('?folder=desk')
      assert.equal(body.results.length, 1)
      return body.results[0]!.items[0]!.text
    }

    const visible = await itemTextAs(readers)
    assert.equal(visible, 'call Bob now')
    assert.ok(!visible.includes('555'))
    assert.equal(await itemTextAs(sourceReaders), source)
    assert.equal(await itemTextAs(writers), source)
  })

  test('pages are sliced after filtering, so totalHits ignores limit and offset', async () => {
    asReader()
    const first = await get('?limit=1')
    assert.equal(first.results.length, 1)
    assert.equal(first.totalHits, 2)
    const second = await get('?limit=1&offset=1')
    assert.equal(second.results.length, 1)
    assert.notEqual(second.results[0]!.path, first.results[0]!.path)
  })
})
