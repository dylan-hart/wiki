import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { sites } from './sites.ts'
import { navigation as navigationModel } from './navigation.ts'
import { pages as pagesModel } from './pages.ts'
import type { PageActor } from './pages.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { navigation as navigationTable, sites as sitesTable } from '../db/schema.ts'

/**
 * Regression test for task 702: `getSiteByHostname`'s precedence — an exact hostname match beats the
 * `*` catch-all, and `strict: true` excludes the catch-all fallback entirely — is what the
 * `api/sites.test.ts` "strict=true does not fall back" tests exercise end-to-end through a stubbed
 * copy of this same logic. This file exercises the real model method directly instead, against a
 * fake `WIKI.sites` / `WIKI.sitesMappings` (exactly what `reloadCache` populates), with no database:
 * `getSiteByHostname` with `forceReload: false` (the default) touches nothing but those two in-memory
 * maps.
 */

const EXACT_SITE_ID = 'exact-site-id'
const WILDCARD_SITE_ID = 'wildcard-site-id'

before(() => {
  ;(globalThis as any).WIKI = {
    sites: {
      [EXACT_SITE_ID]: { id: EXACT_SITE_ID, hostname: 'wiki.example.com', isEnabled: true },
      [WILDCARD_SITE_ID]: { id: WILDCARD_SITE_ID, hostname: '*', isEnabled: true }
    },
    sitesMappings: {
      'wiki.example.com': EXACT_SITE_ID,
      '*': WILDCARD_SITE_ID
    }
  }
})

after(() => {
  delete (globalThis as any).WIKI
})

describe('sites.getSiteByHostname', () => {
  test('an exact hostname match beats the catch-all', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'wiki.example.com' })
    assert.equal(site?.id, EXACT_SITE_ID)
  })

  test('an unmapped hostname falls back to the catch-all when not strict', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'unmapped.example.com', strict: false })
    assert.equal(site?.id, WILDCARD_SITE_ID)
  })

  test('strict: true excludes the catch-all fallback for an unmapped hostname', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'unmapped.example.com', strict: true })
    assert.equal(site, null)
  })

  test('strict: true still returns an exact match', async () => {
    const site = await sites.getSiteByHostname({ hostname: 'wiki.example.com', strict: true })
    assert.equal(site?.id, EXACT_SITE_ID)
  })
})

/**
 * Regression test for task 686: `createSite` unconditionally gives every site its own root
 * navigation row (`navigation.ensureSiteNav`, keyed by `id = siteId`), but until this fix
 * `deleteSite` never cleaned it up — so a brand-new site with zero pages still hit the `navigation`
 * table's FK (no cascade) and failed to delete with a 23503, reported by the route as a 409 "still
 * holds content" conflict. This suite runs the real `deleteSite`/`createPage` methods against a
 * migrated, per-run-fresh database (see `test/db.ts`) rather than mocking the query builder, since
 * the behavior under test is the FK interaction itself.
 */
describe('sites.deleteSite (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Inserts a site row directly (bypassing `createSite`'s default-config/system-id assembly, which
   *  this suite has no need of) and gives it a root nav row exactly as `createSite` does. */
  async function makeSite(): Promise<string> {
    const hostname = `test-${randomBytes(6).toString('hex')}.localhost`
    const [site] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname,
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    await sites.reloadCache()
    await navigationModel.ensureSiteNav(site!.id)
    return site!.id
  }

  test('a freshly created site with no pages deletes cleanly', async () => {
    const siteId = await makeSite()

    const deleted = await sites.deleteSite(siteId)
    assert.equal(deleted, true)

    const remainingNav = await fixtures.db
      .select({ id: navigationTable.id })
      .from(navigationTable)
      .where(eq(navigationTable.id, siteId))
    assert.equal(remainingNav.length, 0)
  })

  test('a site holding a page is still refused with a FK conflict', async () => {
    const siteId = await makeSite()
    await pagesModel.createPage(
      siteId,
      {
        path: 'home',
        title: 'Home',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )

    await assert.rejects(sites.deleteSite(siteId), (err: any) => {
      assert.equal(err.code === '23503' || err.cause?.code === '23503', true)
      return true
    })
  })
})
