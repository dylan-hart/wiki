import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { resolvePageRule } from '../helpers/pageRules.ts'
import type { GroupRule } from '../models/groups.ts'

/**
 * Regression test for `GET .../pages/alias/:alias` (feature 357, task 446).
 *
 * `Pages.getPathFromAlias()` used to select only `{ id, path }`, so this route's
 * `mayOnPage(req, 'read:pages', { path: target.path })` never saw a locale or any tags — a
 * locale- or tag-scoped page rule could never be evaluated for a page reached through its alias,
 * only a path-based one, silently. Fixed by selecting `locale`/`tags` too (`models/pages.ts`) and
 * threading both through into the `mayOnPage` call (`api/pages.ts`).
 *
 * `WIKI.models.groups.checkAccess` is wired to the real `resolvePageRule` from `helpers/pageRules.ts`
 * rather than a canned true/false, so a passing test here proves the actual rule-matching mechanism
 * sees the tags this route now passes through — not just that some stub was called with the right
 * shape. `WIKI.models.pages.getPathFromAlias` is stubbed to stand in for the (separately, DB-backed,
 * tested in `models/pages.test.ts`) fixed model method.
 */

const SITE_ID = '11111111-1111-4111-8111-111111111111'
// -> Tagged both 'public' (generally readable) and 'confidential' (specifically restricted), so the
//    two rules below only disagree because of the tags this route now passes through.
const ALIAS_TARGET = {
  id: 'page-1',
  path: 'engineering/roadmap',
  locale: 'en',
  tags: ['public', 'confidential']
}

let app: FastifyInstance
let rules: GroupRule[]

/** Grants read access to anything tagged 'public' — the baseline, page-context-independent ALLOW. */
const allowPublic: GroupRule = {
  id: 'allow-public',
  name: 'Allow public',
  roles: ['read:pages'],
  match: 'TAG',
  mode: 'ALLOW',
  path: 'public',
  locales: [],
  sites: []
}

/** Same specificity and match type as `allowPublic` (both TAG), so only the mode tiebreak decides. */
const denyConfidential: GroupRule = {
  id: 'deny-confidential',
  name: 'Deny confidential',
  roles: ['read:pages'],
  match: 'TAG',
  mode: 'DENY',
  path: 'confidential',
  locales: [],
  sites: []
}

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: {
        getPathFromAlias: async () => ALIAS_TARGET
      },
      groups: {
        actorForRequest: () => ({ groupIds: ['fixture-group'], permissions: [] }),
        // -> The real rule-matching engine, not a stub answer — see file header.
        checkAccess: (_actor: unknown, permission: string, page: { path: string }) => {
          const rule = resolvePageRule(rules, permission, page)
          return rule ? rule.mode !== 'DENY' : false
        }
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  await registerApprovalSchema(app)
  await registerPageSchema(app)
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  rules = []
})

test('an alias-resolved read is allowed when only a TAG rule grants it', async () => {
  // -> Baseline: with no DENY in play, the tags the route now passes through are what let this
  //    TAG-scoped ALLOW rule fire at all (it cannot match without them).
  rules = [allowPublic]

  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
  })

  assert.equal(res.statusCode, 200)
  // -> The response schema only publishes `id`/`path` — `locale`/`tags` are for the permission
  //    check, not the wire response.
  assert.deepEqual(res.json(), { id: 'page-1', path: 'engineering/roadmap' })
})

test('a TAG-scoped DENY rule is honored on an alias-resolved read', async () => {
  // -> Both rules match this page (tagged 'public' AND 'confidential'); equal specificity and match
  //    type means the DENY wins the tiebreak. Reachable only because the route now threads
  //    `target.tags` into `mayOnPage` — before the fix, neither TAG rule could ever match at all,
  //    since `page.tags` was always empty.
  rules = [allowPublic, denyConfidential]

  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
  })

  // -> Resolving an alias the caller may not read answers 404, identically to an alias that does
  //    not exist at all — see the route's own comment.
  assert.equal(res.statusCode, 404)
})
