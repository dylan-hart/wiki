import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { resolvePageRule, type RulePageRef } from '../../helpers/pageRules.ts'
import type { GroupRule } from '../../models/groups.ts'

/**
 * Every fixture grants `write:pages` everywhere, so a refusal in these tests is the `write:tags`
 * guardrail's doing alone.
 */
describe('write:tags is required, independently of write:pages, to actually change a page’s tag set (OpenProject #3393)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const OTHER_ID = '33333333-3333-4333-8333-333333333333'

  const writePagesAnywhere: GroupRule = {
    id: 'write-pages-anywhere',
    name: 'Write pages anywhere',
    roles: ['write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['en'],
    sites: []
  }

  const writeTagsAnywhere: GroupRule = {
    id: 'write-tags-anywhere',
    name: 'Write tags anywhere',
    roles: ['write:tags'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['en'],
    sites: []
  }

  const denyTagConfidential: GroupRule = {
    id: 'deny-tag-confidential',
    name: 'Deny write:tags on confidential',
    roles: ['write:tags'],
    match: 'TAG',
    mode: 'DENY',
    path: '',
    locales: [],
    sites: [],
    tags: ['confidential']
  }

  function makeCheckAccess(rules: GroupRule[]) {
    return (_actor: unknown, permission: string, page: RulePageRef) => {
      const rule = resolvePageRule(rules, permission, page)
      return rule ? rule.mode !== 'DENY' : false
    }
  }

  describe('PATCH /sites/:siteId/pages/:pageId', () => {
    let app: FastifyInstance
    let updatePageCalls: any[]
    let target: { id: string; path: string; locale: string; tags: string[]; classification: null }

    before(async () => {
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
            checkAccess: makeCheckAccess([writePagesAnywhere, writeTagsAnywhere])
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
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere,
        writeTagsAnywhere
      ])
    })

    test('adding a tag write:tags is denied on (the POST-change side) is refused even though write:pages allows it everywhere', async () => {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere,
        writeTagsAnywhere,
        denyTagConfidential
      ])
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

    test('removing the only tag write:tags is denied on is refused too (the PRE-change side)', async () => {
      target.tags = ['confidential']
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere,
        writeTagsAnywhere,
        denyTagConfidential
      ])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: [] }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updatePageCalls.length, 0)
    })

    test('holding write:pages but not write:tags at all is refused on any real tag change', async () => {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere
      ])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: ['news'] }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(updatePageCalls.length, 0)
    })

    test('holding write:pages but not write:tags can still save the page when its tag set is unchanged', async () => {
      target.tags = ['news']
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere
      ])
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: ['news'], title: 'Retitled' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
    })

    test('adding a tag nothing denies succeeds with both write:pages and write:tags held', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
        payload: { tags: ['news'] }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(updatePageCalls.length, 1)
      assert.deepEqual(updatePageCalls[0].patch.tags, ['news'])
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
            checkAccess: makeCheckAccess([writePagesAnywhere, writeTagsAnywhere])
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
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere,
        writeTagsAnywhere
      ])
    })

    test('adding a tag write:tags denies is refused for every selected page, per page, even though write:pages allows it', async () => {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere,
        writeTagsAnywhere,
        denyTagConfidential
      ])
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
    })

    test('write:pages alone (no write:tags at all) skips every page whose tag set would actually change', async () => {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere
      ])
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/bulk`,
        payload: {
          pageIds: [PAGE_ID, OTHER_ID],
          action: 'retag',
          addTags: ['docs']
        }
      })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
      assert.equal(byId[PAGE_ID].status, 'skipped')
      assert.equal(byId[OTHER_ID].status, 'skipped')
      assert.deepEqual(updateCalls, [])
    })

    test('write:pages alone still applies a retag whose tag set does not actually change', async () => {
      ;(globalThis as any).CARDINAL.models.groups.checkAccess = makeCheckAccess([
        writePagesAnywhere
      ])
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/bulk`,
        payload: {
          pageIds: [OTHER_ID],
          action: 'retag',
          addTags: ['news']
        }
      })
      assert.equal(res.statusCode, 200)
      const body = res.json()
      assert.equal(body.results[0].status, 'done')
      assert.deepEqual(updateCalls, [{ id: OTHER_ID, patch: { tags: ['news'] } }])
    })
  })
})
