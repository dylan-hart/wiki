import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
import tagsRoutes from './tags.ts'
import type { GroupRule } from '../models/groups.ts'
import type { PageActor } from '../models/pages.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * DB-backed route test for `PATCH`/`DELETE /sites/:siteId/tags/:tag` (OpenProject #1873).
 *
 * `manage:pages` is a page rule permission — decided PER PAGE against the real rule matching in
 * `helpers/pageRules.ts`, not a group-wide list — so this runs the real routes, the real
 * `groups`/`pages`/`tags`/`search` models and a real, migrated database (see `test/db.ts`), mirroring
 * `api/comments.admin.test.ts`'s shape for the same reason: a stubbed `checkAccess` would only prove
 * the route calls a function, not that per-page scoping actually works.
 *
 * There is no real session plugin here — `req.session` is set directly by an `onRequest` hook from a
 * per-test-mutable `testSession` variable, which is all `WIKI.models.groups.actorForRequest` reads.
 */
describe('PATCH/DELETE /sites/:siteId/tags/:tag (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let app: FastifyInstance
  let groupsModel: typeof import('../models/groups.ts').groups
  let pagesModel: typeof import('../models/pages.ts').pages
  let searchModel: typeof import('../models/search.ts').search
  let testSession: any = null
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('../models/groups.ts'))
    ;({ pages: pagesModel } = await import('../models/pages.ts'))
    ;({ search: searchModel } = await import('../models/search.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    // -> `buildTestApp` installs the REAL error handler, which is what shapes `reply.notFound()`
    //    etc. into the `ApiError` schema (`ok`/`error`/`statusCode`/`message`) the routes' own 404
    //    response schemas declare — without it, `@fastify/sensible`'s bare
    //    `{statusCode, error, message}` fails schema serialization (missing `ok`) and the route
    //    answers 500 instead of 404. No `wiki`: `setupTestDb()` already installed the real one.
    app = await buildTestApp({ routes: tagsRoutes, session: () => testSession })
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
    id: 'rule-1',
    name: 'Test Rule',
    roles: ['manage:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: [],
    sites: [],
    ...overrides
  })

  async function setGroupRules(rules: GroupRule[]): Promise<void> {
    await fixtures.db.update(groupsTable).set({ rules }).where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
  }

  test('PATCH 404s for a tag that carries no page on this site', async () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: ['manage:system']
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${fixtures.siteId}/tags/no-such-tag`,
      payload: { newTag: 'whatever' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('renaming to a tag a page already carries de-duplicates rather than doubling it', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'dedupe/page',
        title: 'Dedupe',
        editor: 'markdown',
        content: 'x',
        tags: ['typo', 'correct']
      },
      actor
    )

    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: ['manage:system']
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${fixtures.siteId}/tags/typo`,
      payload: { newTag: 'correct' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, updated: 1 })

    const reloaded = await pagesModel.getPage({ siteId: fixtures.siteId, id: page.id })
    assert.deepEqual(reloaded!.tags, ['correct'])
  })

  test('a page the actor lacks manage:pages on is skipped while the rest proceed', async () => {
    const covered = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'scope-a/page',
        title: 'Covered',
        editor: 'markdown',
        content: 'x',
        tags: ['legacy']
      },
      actor
    )
    const uncovered = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'scope-b/page',
        title: 'Uncovered',
        editor: 'markdown',
        content: 'x',
        tags: ['legacy']
      },
      actor
    )

    // -> Grants manage:pages on scope-a only — NOT scope-b.
    await setGroupRules([rule({ path: 'scope-a' })])
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [fixtures.groupId],
      permissions: []
    }

    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${fixtures.siteId}/tags/legacy`,
      payload: { newTag: 'current' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, updated: 1 })

    const coveredReloaded = await pagesModel.getPage({ siteId: fixtures.siteId, id: covered.id })
    assert.deepEqual(coveredReloaded!.tags, ['current'])
    const uncoveredReloaded = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: uncovered.id
    })
    assert.deepEqual(uncoveredReloaded!.tags, ['legacy'])
  })

  test('a renamed tag is reflected in search results afterwards', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'searchable/page',
        title: 'Searchable',
        editor: 'markdown',
        content: 'x',
        tags: ['stale-name']
      },
      actor
    )

    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [],
      permissions: ['manage:system']
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${fixtures.siteId}/tags/stale-name`,
      payload: { newTag: 'fresh-name' }
    })
    assert.equal(res.statusCode, 200)

    const withNewTag = await searchModel.query({ siteId: fixtures.siteId, tags: ['fresh-name'] })
    assert.equal(withNewTag.results.length, 1)
    assert.equal(withNewTag.results[0]!.path, 'searchable/page')

    const withOldTag = await searchModel.query({ siteId: fixtures.siteId, tags: ['stale-name'] })
    assert.equal(withOldTag.results.length, 0)
  })

  test('DELETE removes the tag from every page the actor may manage, leaving the rest untouched', async () => {
    const covered = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'delete-a/page',
        title: 'Covered',
        editor: 'markdown',
        content: 'x',
        tags: ['doomed']
      },
      actor
    )
    const uncovered = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'delete-b/page',
        title: 'Uncovered',
        editor: 'markdown',
        content: 'x',
        tags: ['doomed']
      },
      actor
    )

    await setGroupRules([rule({ path: 'delete-a' })])
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [fixtures.groupId],
      permissions: []
    }

    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${fixtures.siteId}/tags/doomed`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, updated: 1 })

    const coveredReloaded = await pagesModel.getPage({ siteId: fixtures.siteId, id: covered.id })
    assert.deepEqual(coveredReloaded!.tags, [])
    const uncoveredReloaded = await pagesModel.getPage({
      siteId: fixtures.siteId,
      id: uncovered.id
    })
    assert.deepEqual(uncoveredReloaded!.tags, ['doomed'])
  })
})
