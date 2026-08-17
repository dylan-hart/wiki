import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { sites as sitesTable } from '../db/schema.ts'

/**
 * Regression coverage for Task 588: `createSite()`'s default config used to carry a dead
 * `logoUrl: ''` field that `init()`'s default site config never had (confirmed by diffing the two
 * blocks — see CLAUDE.md's note on not writing fallbacks for cases that cannot occur). Logo is
 * fully handled by the `assets.logo` binary upload flow served at `/_site/:siteId/logo`; `logoUrl`
 * was never read anywhere in `frontend/`, nor accepted by the `PUT /_api/sites/:siteId` body. This
 * suite asserts the stored config a fresh site gets from `createSite()` no longer contains it, and
 * that the fields still genuinely needed continue to round-trip through the insert unchanged.
 */
describe('sites.createSite (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sitesModel: typeof import('./sites.ts').sites

  before(async () => {
    fixtures = await setupTestDb()
    ;({ sites: sitesModel } = await import('./sites.ts'))
    // -> `createSite()` reads `WIKI.data.systemIds.localAuthId` to seed the default auth strategy —
    //    real values come from `base.yml` via `core/config.ts`, neither of which the minimal test
    //    `WIKI` global in `test/db.ts` populates.
    WIKI.data.systemIds = { localAuthId: '5a528c4c-0a82-4ad2-96a5-2b23811e6588' }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('stored config has no logoUrl field, and still carries the fields the admin UI round-trips', async () => {
    const site = await sitesModel.createSite('sites-test.localhost')
    const [row] = await fixtures.db.select().from(sitesTable).where(eq(sitesTable.id, site.id))

    assert.equal(
      Object.prototype.hasOwnProperty.call(row!.config as object, 'logoUrl'),
      false,
      'createSite() default config should no longer contain the dead logoUrl field'
    )

    const config = row!.config as Record<string, any>
    assert.equal(config.title, 'My Wiki Site')
    assert.equal(config.description, '')
    assert.equal(config.company, '')
    assert.equal(config.contentLicense, '')
    assert.equal(config.footerExtra, '')
    assert.deepEqual(config.pageExtensions, ['md', 'html', 'txt'])
    assert.equal(config.logoText, true)
    assert.equal(config.discoverable, false)
    assert.equal(config.sitemap, true)
    assert.deepEqual(config.robots, { index: true, follow: true })
    assert.deepEqual(config.uploads, { conflictBehavior: 'overwrite' })
    assert.deepEqual(config.defaults, { tocDepth: { min: 1, max: 2 } })
    assert.deepEqual(config.features, {
      browse: true,
      collaborativeEditing: true,
      ratings: false,
      ratingsMode: 'off',
      comments: false,
      profile: true,
      reasonForChange: 'optional',
      search: true
    })
  })
})
