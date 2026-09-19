import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { resolvePageRule, type RulePageRef } from '../../helpers/pageRules.ts'
import type { GroupRule } from '../../models/groups.ts'

/**
 * `checkAccess` is wired to the real `resolvePageRule`, so a pass is the rule engine seeing the
 * post-change ref, not a stub agreeing it was called.
 */
describe('retag checks the page as it leaves, not just as it stands (OpenProject #3410)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const OTHER_ID = '33333333-3333-4333-8333-333333333333'

  /** Carries `write:tags` too, so the `write:pages` gate is the only one that can refuse here. */
  const writeAnywhere: GroupRule = {
    id: 'write-anywhere',
    name: 'Write anywhere',
    roles: ['write:pages', 'write:tags'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['en'],
    sites: []
  }

  const denyConfidential: GroupRule = {
    id: 'deny-confidential',
    name: 'Deny confidential',
    roles: ['write:pages'],
    match: 'TAG',
    mode: 'DENY',
    path: '',
    locales: [],
    sites: [],
    tags: ['confidential']
  }

  const realCheckAccess = (_actor: unknown, permission: string, page: RulePageRef) => {
    const rule = resolvePageRule([writeAnywhere, denyConfidential], permission, page)
    return rule ? rule.mode !== 'DENY' : false
  }

  describe('PATCH /sites/:siteId/pages/:pageId', () => {
    let app: FastifyInstance
    let updatePageCalls: any[]
    let target: { id: string; path: string; locale: string; tags: string[]; classification: null }

    before(async () => {
      // -> The PATCH handler calls `page.updatedAt.toTemporalInstant()`.
      await ensureTemporal()
      const wiki = {
        models: {
          pages: {
            getPage: async () => ({ ...target, updatedAt: new Date() }),
            updatePage: async (siteId: string, id: string, patch: any) => {
              updatePageCalls.push({ siteId, id, patch })
              return {
                id,
                path: target.path,
                locale: target.locale,
                classification: target.classification,
                tags: patch.tags ?? target.tags,
                updatedAt: new Date(),
                authorName: ''
              }
            }
          },
          groups: {
            actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
            groupIdsForRequest: () => ['g1'],
            checkAccess: realCheckAccess
          },
          classificationLevels: { isLowerThan: () => false }
        },
        sites: { [SITE_ID]: {} },
        collab: { pageSaved: () => {} }
      }
      app = await buildTestApp({
        routes: pagesRoutes,
        ajv: true,
        wiki,
        session: { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      })
    })

    after(() => closeTestApp(app))

    beforeEach(() => {
      updatePageCalls = []
      target = { id: PAGE_ID, path: 'docs/report', locale: 'en', tags: [], classification: null }
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = realCheckAccess
    })

    test('adding a tag the caller is denied write:pages on is refused, before updatePage runs', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: ['confidential'] }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(
        res.json().message,
        'You are not allowed to change this page’s tags to that set.'
      )
      assert.equal(updatePageCalls.length, 0)
    })

    test('removing the only tag a DENY rule covers is refused just the same, since the page still holds it as it stands', async () => {
      target.tags = ['confidential']
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: [] }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updatePageCalls.length, 0)
    })

    test('adding a tag nothing denies succeeds', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: ['news'] }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
      assert.deepEqual(updatePageCalls[0].patch.tags, ['news'])
    })

    test('resubmitting the current tags, reordered, needs no second checkAccess call and is never refused', async () => {
      target.tags = ['a', 'b']
      let checkAccessCalls = 0
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
        actor: unknown,
        permission: string,
        page: RulePageRef
      ) => {
        checkAccessCalls++
        return realCheckAccess(actor, permission, page)
      }
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: ['b', 'a'] }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
      // -> The one call is the pre-change `hasWrite` gate.
      assert.equal(checkAccessCalls, 1)
    })

    test('a body with no tags field at all never triggers a second write:pages check', async () => {
      target.tags = ['a', 'b']
      let checkAccessCalls = 0
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
        actor: unknown,
        permission: string,
        page: RulePageRef
      ) => {
        checkAccessCalls++
        return realCheckAccess(actor, permission, page)
      }
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { title: 'Retitled' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
      assert.equal(checkAccessCalls, 1)
    })
  })

  describe('POST /sites/:siteId/pages/bulk — retag', () => {
    let app: FastifyInstance
    let updateCalls: { id: string; patch: any }[]
    let pageRows: Map<
      string,
      { id: string; path: string; locale: string; tags: string[]; classification: string | null }
    >

    before(async () => {
      const wiki = {
        config: { port: 3000 },
        models: {
          rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
          groups: {
            actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
            groupIdsForRequest: () => ['g1'],
            checkAccess: realCheckAccess
          },
          pages: {
            getPagesByIds: async (_siteId: string, ids: string[]) => {
              const out = new Map()
              for (const id of ids) {
                if (pageRows.has(id)) {
                  out.set(id, pageRows.get(id))
                }
              }
              return out
            },
            updatePage: async (_siteId: string, id: string, patch: any) => {
              updateCalls.push({ id, patch })
              return { id, ...patch }
            }
          }
        }
      }
      app = await buildTestApp({
        routes: pagesRoutes,
        ajv: true,
        wiki,
        session: { authenticated: true, user: { id: 'user-1' }, permissions: [] }
      })
    })

    after(() => closeTestApp(app))

    beforeEach(() => {
      updateCalls = []
      pageRows = new Map([
        [
          PAGE_ID,
          { id: PAGE_ID, path: 'docs/report', locale: 'en', tags: [], classification: null }
        ],
        [
          OTHER_ID,
          { id: OTHER_ID, path: 'docs/other', locale: 'en', tags: ['news'], classification: null }
        ]
      ])
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = realCheckAccess
    })

    test('adding a denied tag to every selected page is refused for each of them, per page', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/bulk`,
        payload: {
          pageIds: [PAGE_ID, OTHER_ID],
          action: 'retag',
          addTags: ['confidential']
        }
      })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
      assert.equal(byId[PAGE_ID].status, 'skipped')
      assert.equal(byId[OTHER_ID].status, 'skipped')
      assert.deepEqual(updateCalls, [])
      assert.deepEqual(body.counts, { skipped: 2 })
    })

    test('within one batch, only the page whose RESULTING tags a rule denies is skipped -- proven with a rule the PRE-change ref alone could not have caught', async () => {
      // -> TAGALL on `draft` + `confidential` together: no page carries both yet, so every
      //    pre-change ref passes and only the post-change check can catch the page that would.
      const denyDraftAndConfidential: GroupRule = {
        id: 'deny-draft-confidential',
        name: 'Deny draft+confidential together',
        roles: ['write:pages'],
        match: 'TAGALL',
        mode: 'DENY',
        path: '',
        locales: [],
        sites: [],
        tags: ['draft', 'confidential']
      }
      const rules = [writeAnywhere, denyDraftAndConfidential]
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = (
        _actor: unknown,
        permission: string,
        page: RulePageRef
      ) => {
        const rule = resolvePageRule(rules, permission, page)
        return rule ? rule.mode !== 'DENY' : false
      }
      pageRows.get(PAGE_ID)!.tags = []
      pageRows.get(OTHER_ID)!.tags = ['draft']

      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/bulk`,
        payload: {
          pageIds: [PAGE_ID, OTHER_ID],
          action: 'retag',
          addTags: ['confidential']
        }
      })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
      // -> Ends up with `confidential` alone; the TAGALL rule needs both.
      assert.equal(byId[PAGE_ID].status, 'done')
      // -> Already had `draft`, so gaining `confidential` completes the denied pair.
      assert.equal(byId[OTHER_ID].status, 'skipped')
      assert.deepEqual(updateCalls, [{ id: PAGE_ID, patch: { tags: ['confidential'] } }])
      assert.deepEqual(body.counts, { done: 1, skipped: 1 })
    })

    test('removing the tag a DENY rule covers is refused per page too', async () => {
      pageRows.get(PAGE_ID)!.tags = ['confidential']
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/bulk`,
        payload: {
          pageIds: [PAGE_ID],
          action: 'retag',
          removeTags: ['confidential']
        }
      })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.equal(body.results[0].status, 'skipped')
      assert.deepEqual(updateCalls, [])
    })

    test('a retag nothing denies still applies to every page, whether or not its own tag set actually changes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/bulk`,
        payload: {
          pageIds: [PAGE_ID, OTHER_ID],
          action: 'retag',
          addTags: ['news']
        }
      })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
      assert.equal(byId[PAGE_ID].status, 'done')
      // -> Already carries `news`: the retag check is skipped, but the write still happens.
      assert.equal(byId[OTHER_ID].status, 'done')
      assert.equal(updateCalls.length, 2)
    })
  })
})
