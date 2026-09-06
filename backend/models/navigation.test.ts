import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import {
  groups as groupsTable,
  navigation as navigationTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'
import {
  assertValidNavItems,
  isValidNavItemTarget,
  NAVIGATION_MODES,
  sanitizeNavItemTargets,
  type NavigationItem,
  type NavigationMode
} from './navigation.ts'
import type { PageActor, PageInput } from './pages.ts'
import type { AccessActor } from './groups.ts'

/** A permissive stand-in actor for getNav() calls in tests that aren't specifically
 *  about page-rule filtering (OpenProject #2155) -- manage:system bypasses checkAccess
 *  entirely, matching this file's pre-#2155 behavior for everything but the dedicated
 *  permission-filtering tests, which build their own narrower actor. */
const ADMIN_ACTOR = { groupIds: [] as string[], permissions: ['manage:system'] }

/**
 * OpenProject #2208 §3: pure unit coverage of the item-target validation `setNavItems`,
 * `updateNavigation` and `copyNav` all now call before writing — no `WIKI` global and no database
 * needed, per this repo's own preference for a pure test over a DB-backed one wherever the thing
 * under test is not itself SQL orchestration (see CLAUDE.md's "Testing (backend)" section). The
 * DB-backed `setNavItems`/`copyNav` describe blocks further down in this file cover the write/copy
 * round trip itself; this covers the validation logic they both now run on the way in.
 */
describe('isValidNavItemTarget / assertValidNavItems / sanitizeNavItemTargets', () => {
  test('an absent or empty target is valid (header/separator, or an unpointed link)', () => {
    assert.equal(isValidNavItemTarget(undefined), true)
    assert.equal(isValidNavItemTarget(''), true)
  })

  test('a bare rooted path is valid', () => {
    assert.equal(isValidNavItemTarget('/some/page'), true)
  })

  test('an absolute https:// URL is valid', () => {
    assert.equal(isValidNavItemTarget('https://example.com/x'), true)
  })

  test('mailto: and tel: are valid -- legitimate nav item destinations', () => {
    assert.equal(isValidNavItemTarget('mailto:person@example.com'), true)
    assert.equal(isValidNavItemTarget('tel:+15555550100'), true)
  })

  test('javascript: is refused', () => {
    assert.equal(isValidNavItemTarget('javascript:alert(1)'), false)
  })

  test('javascript://%0aalert(1) is refused (the naive-regex bypass)', () => {
    assert.equal(isValidNavItemTarget('javascript://%0aalert(1)'), false)
  })

  test('data: is refused', () => {
    assert.equal(isValidNavItemTarget('data:text/html,<script>alert(1)</script>'), false)
  })

  test('a protocol-relative //host is refused', () => {
    assert.equal(isValidNavItemTarget('//evil.example'), false)
  })

  test('assertValidNavItems throws on a top-level item with a javascript: target', () => {
    assert.throws(
      () => assertValidNavItems([{ id: 'a', type: 'link', target: 'javascript:alert(1)' }]),
      /invalid target/i
    )
  })

  test('assertValidNavItems throws on a NESTED child target, not just top-level items', () => {
    assert.throws(
      () =>
        assertValidNavItems([
          {
            id: 'a',
            type: 'link',
            target: '/fine',
            children: [{ id: 'b', type: 'link', target: 'javascript:alert(1)' }]
          }
        ]),
      /invalid target/i
    )
  })

  test('assertValidNavItems does not throw for a menu with only valid targets', () => {
    assert.doesNotThrow(() =>
      assertValidNavItems([
        { id: 'a', type: 'link', target: '/fine' },
        { id: 'b', type: 'header' },
        {
          id: 'c',
          type: 'link',
          target: 'https://example.com',
          children: [{ id: 'd', type: 'link', target: 'mailto:x@example.com' }]
        }
      ])
    )
  })

  test('sanitizeNavItemTargets blanks an invalid target, top-level and nested alike, leaving the rest of the item intact', () => {
    const sanitized = sanitizeNavItemTargets([
      {
        id: 'a',
        type: 'link',
        label: 'Evil',
        target: 'javascript:alert(1)',
        children: [
          { id: 'b', type: 'link', label: 'Also evil', target: 'data:text/html,x' },
          { id: 'c', type: 'link', label: 'Fine', target: '/ok' }
        ]
      }
    ])
    assert.equal(sanitized[0]!.target, '')
    assert.equal(sanitized[0]!.label, 'Evil')
    assert.equal(sanitized[0]!.children![0]!.target, '')
    assert.equal(sanitized[0]!.children![1]!.target, '/ok')
  })

  test('sanitizeNavItemTargets leaves an already-valid menu untouched', () => {
    const items: NavigationItem[] = [{ id: 'a', type: 'link', target: '/fine' }]
    assert.deepEqual(sanitizeNavItemTargets(items), items)
  })
})

/**
 * `listOverrides` is a flat, indexed scan against `tree` — no ltree ancestry logic to mock, so this
 * runs the real method against a migrated, per-run-fresh database (see `test/db.ts`), the same
 * approach `models/pages.test.ts` takes for its own SQL-orchestration-heavy paths.
 */
describe('navigation listOverrides (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  test('an entry left on inherit does not show up', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'still-inheriting', title: 'Still Inheriting' }),
      actor
    )

    const overrides = await navigationModel.listOverrides(fixtures.siteId)
    assert.deepEqual(
      overrides.filter((o) => o.title === 'Still Inheriting'),
      []
    )
  })

  test('overriding a page via updateNavigation makes it show up, ordered by folderPath/fileName', async () => {
    const zebra = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'zebra', title: 'Zebra' }),
      actor
    )
    const alpha = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'alpha', title: 'Alpha' }),
      actor
    )

    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: zebra.id,
      mode: 'override'
    })
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: alpha.id,
      mode: 'hide'
    })

    const overrides = await navigationModel.listOverrides(fixtures.siteId)
    const relevant = overrides.filter((o) => ['Alpha', 'Zebra'].includes(o.title))

    // -> Both at the site root (empty folderPath), so ordering falls through to fileName: alpha before
    //    zebra
    assert.deepEqual(
      relevant.map((o) => o.title),
      ['Alpha', 'Zebra']
    )

    const alphaRow = relevant.find((o) => o.title === 'Alpha')!
    assert.equal(alphaRow.type, 'page')
    assert.equal(alphaRow.folderPath, '')
    assert.equal(alphaRow.fileName, 'alpha')
    assert.equal(alphaRow.locale, 'en')
    assert.equal(alphaRow.navigationMode, 'hide')
    assert.equal(alphaRow.navigationId, null)

    const zebraRow = relevant.find((o) => o.title === 'Zebra')!
    assert.equal(zebraRow.navigationMode, 'override')
    assert.equal(zebraRow.navigationId, zebra.id)
  })

  test('a folder entry overriding navigation shows up too', async () => {
    const folderId = crypto.randomUUID()
    await WIKI.db.insert(treeTable).values({
      id: folderId,
      folderPath: '',
      fileName: 'reference-folder',
      type: 'folder',
      locale: 'en',
      title: 'Reference Folder',
      navigationMode: 'overrideExact',
      siteId: fixtures.siteId
    })

    const overrides = await navigationModel.listOverrides(fixtures.siteId)
    const folderRow = overrides.find((o) => o.id === folderId)
    assert.ok(folderRow)
    assert.equal(folderRow!.type, 'folder')
    assert.equal(folderRow!.navigationMode, 'overrideExact')
  })

  test('locale filters the list to one locale', async () => {
    const frPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'locale-page', title: 'Locale Page', locale: 'fr' }),
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: frPage.id,
      mode: 'override'
    })

    const frOnly = await navigationModel.listOverrides(fixtures.siteId, { locale: 'fr' })
    assert.ok(frOnly.some((o) => o.id === frPage.id))

    const enOnly = await navigationModel.listOverrides(fixtures.siteId, { locale: 'en' })
    assert.ok(!enOnly.some((o) => o.id === frPage.id))
  })
})

/**
 * `setNavItems` is what the admin-launched editor (Task 433) saves against: unlike
 * `updateNavigation`, it writes straight to a navigation row by id, with no page/mode resolution --
 * the caller (AdminNavigation.vue) already knows which row it means, either a site-wide default's own
 * row id (from `ensureSiteNav`) or an override's own `navigationId` from `listOverrides`.
 */
describe('navigation setNavItems (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('writes to the site-wide default menu, addressed by its own row id', async () => {
    const items = [{ id: 'a', type: 'link' as const, label: 'Home', target: '/' }]

    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    // -> The row is a real, freshly-generated id -- not the site id it belongs to
    assert.notEqual(siteNavId, fixtures.siteId)

    await navigationModel.setNavItems(fixtures.siteId, siteNavId, items)

    const stored = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.deepEqual(stored, items)
  })

  test("writes to an override tree entry's own navigation row", async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'set-nav-items-page',
        title: 'Set Nav Items Page',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override'
    })

    const items = [{ id: 'b', type: 'header' as const, label: 'Section' }]
    await navigationModel.setNavItems(fixtures.siteId, page.id, items)

    const stored = await navigationModel.getNav(fixtures.siteId, page.id, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.deepEqual(stored, items)
  })

  test('rejects a navId that names neither an existing menu row of this site nor a tree entry in it', async () => {
    await assert.rejects(
      () => navigationModel.setNavItems(fixtures.siteId, crypto.randomUUID(), []),
      /does not exist/
    )
  })

  /**
   * OpenProject #1360/#2208 (2026-08-24 security audit §3): a nav item's `target` renders as an
   * unsanitized `<a :href>` (`WItem.vue`) for every reader of every page on the site, so it must be a
   * same-origin path or an `http(s)`/`mailto`/`tel` target — never `javascript:` or a scheme-relative
   * `//host` a browser would resolve as absolute and off-origin.
   */
  test('rejects a javascript: target, top-level or nested, and writes nothing', async () => {
    // -> A locale of its own, distinct from every other test in this describe block: `ensureSiteNav`
    //    is idempotent per `(siteId, locale)`, and reusing a locale another test already wrote to
    //    would make the "wrote nothing" assertion below see that test's leftover items instead.
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'nl')

    await assert.rejects(
      () =>
        navigationModel.setNavItems(fixtures.siteId, siteNavId, [
          { id: 'a', type: 'link' as const, label: 'Evil', target: 'javascript:alert(1)' }
        ]),
      /has an invalid target/
    )

    await assert.rejects(
      () =>
        navigationModel.setNavItems(fixtures.siteId, siteNavId, [
          {
            id: 'a',
            type: 'link' as const,
            label: 'Parent',
            target: '/fine',
            children: [
              { id: 'b', type: 'link' as const, label: 'Evil Child', target: 'javascript:alert(1)' }
            ]
          }
        ]),
      /has an invalid target/
    )

    // -> Neither attempt wrote anything -- the row is still whatever ensureSiteNav seeded it with
    const stored = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.deepEqual(stored, [])
  })

  test('rejects a scheme-relative //host target the same way', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'sv')
    await assert.rejects(
      () =>
        navigationModel.setNavItems(fixtures.siteId, siteNavId, [
          { id: 'a', type: 'link' as const, label: 'Phish', target: '//attacker.example' }
        ]),
      /has an invalid target/
    )
  })

  test('accepts a rooted path, a complete https:// URL, a mailto: and a tel: target', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'da')
    const items = [
      { id: 'a', type: 'link' as const, label: 'Home', target: '/' },
      { id: 'b', type: 'link' as const, label: 'Ext', target: 'https://example.com' },
      { id: 'c', type: 'link' as const, label: 'Mail', target: 'mailto:hello@example.com' },
      { id: 'd', type: 'link' as const, label: 'Call', target: 'tel:+15551234567' }
    ]
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, items)
    const stored = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.deepEqual(stored, items)
  })
})

/**
 * `copyNav` is what a "copy from locale"/cross-site copy button saves against: unlike `setNavItems`,
 * it reads a whole source menu and writes cloned items onto a target, rather than items the caller
 * already assembled itself.
 */
describe('navigation copyNav (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('replace overwrites the target items with clones of the source, each with a fresh id', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')

    const sourceItems = [
      {
        id: 'source-parent',
        type: 'link' as const,
        label: 'Parent',
        target: '/parent',
        visibilityGroups: [fixtures.groupId],
        children: [{ id: 'source-child', type: 'link' as const, label: 'Child', target: '/child' }]
      }
    ]
    await navigationModel.setNavItems(fixtures.siteId, sourceId, sourceItems)
    await navigationModel.setNavItems(fixtures.siteId, targetId, [
      { id: 'target-existing', type: 'header' as const, label: 'Existing' }
    ])

    await navigationModel.copyNav({
      sourceSiteId: fixtures.siteId,
      sourceId,
      targetSiteId: fixtures.siteId,
      targetId,
      mode: 'replace'
    })

    const targetItems = await navigationModel.getNav(fixtures.siteId, targetId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.equal(targetItems.length, 1)
    const [copied] = targetItems
    assert.notEqual(copied!.id, 'source-parent')
    assert.equal(copied!.label, 'Parent')
    assert.deepEqual(copied!.visibilityGroups, [fixtures.groupId])
    assert.equal(copied!.children!.length, 1)
    assert.notEqual(copied!.children![0]!.id, 'source-child')
    assert.equal(copied!.children![0]!.label, 'Child')

    // -> The source is left untouched
    const sourceStillIntact = await navigationModel.getNav(fixtures.siteId, sourceId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.equal(sourceStillIntact[0]!.id, 'source-parent')
  })

  test('append pushes clones onto the target existing items rather than replacing them', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'de')
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'es')

    await navigationModel.setNavItems(fixtures.siteId, sourceId, [
      { id: 'append-source', type: 'link' as const, label: 'From Source', target: '/x' }
    ])
    await navigationModel.setNavItems(fixtures.siteId, targetId, [
      { id: 'append-target', type: 'link' as const, label: 'Already There', target: '/y' }
    ])

    await navigationModel.copyNav({
      sourceSiteId: fixtures.siteId,
      sourceId,
      targetSiteId: fixtures.siteId,
      targetId,
      mode: 'append'
    })

    const targetItems = await navigationModel.getNav(fixtures.siteId, targetId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.deepEqual(
      targetItems.map((i) => i.label),
      ['Already There', 'From Source']
    )
    assert.equal(targetItems[0]!.id, 'append-target')
    assert.notEqual(targetItems[1]!.id, 'append-source')
  })

  /**
   * OpenProject #2217: `copyNav` used to copy `target` unrewritten, so a source menu poisoned before
   * this check existed (or written straight to the database) could reintroduce a `javascript:` item
   * into a fresh menu via a plain "copy from locale". A safe target still travels over unchanged.
   *
   * `setNavItems` itself now refuses a `javascript:` target outright (`assertValidNavItems`), so the
   * poisoned source row here is written straight to the table with a raw `WIKI.db.update` -- exactly
   * the "predates this validation" scenario `sanitizeNavItemTargets`'s own doc comment describes --
   * rather than through the model, which this test would never get past otherwise.
   */
  test('drops an unsafe target instead of duplicating it onto the target menu', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'ja')
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'ko')

    await WIKI.db
      .update(navigationTable)
      .set({
        items: [
          { id: 'safe-path', type: 'link', label: 'Safe Path', target: '/safe' },
          { id: 'safe-url', type: 'link', label: 'Safe URL', target: 'https://example.com' },
          { id: 'unsafe', type: 'link', label: 'Unsafe', target: 'javascript:alert(1)' }
        ]
      })
      .where(eq(navigationTable.id, sourceId))

    await navigationModel.copyNav({
      sourceSiteId: fixtures.siteId,
      sourceId,
      targetSiteId: fixtures.siteId,
      targetId,
      mode: 'replace'
    })

    const targetItems = await navigationModel.getNav(fixtures.siteId, targetId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    const byLabel = Object.fromEntries(targetItems.map((i) => [i.label, i.target]))
    assert.equal(byLabel['Safe Path'], '/safe')
    assert.equal(byLabel['Safe URL'], 'https://example.com')
    assert.equal(byLabel['Unsafe'], '')
  })

  test('rejects a sourceId that does not resolve to an existing menu row', async () => {
    const targetId = await navigationModel.ensureSiteNav(fixtures.siteId, 'pt')
    await assert.rejects(
      () =>
        navigationModel.copyNav({
          sourceSiteId: fixtures.siteId,
          sourceId: crypto.randomUUID(),
          targetSiteId: fixtures.siteId,
          targetId,
          mode: 'replace'
        }),
      /source menu does not exist/
    )
  })

  test('rejects a targetId that does not resolve to an existing menu row', async () => {
    const sourceId = await navigationModel.ensureSiteNav(fixtures.siteId, 'it')
    await assert.rejects(
      () =>
        navigationModel.copyNav({
          sourceSiteId: fixtures.siteId,
          sourceId,
          targetSiteId: fixtures.siteId,
          targetId: crypto.randomUUID(),
          mode: 'replace'
        }),
      /target menu does not exist/
    )
  })
})

/**
 * The site-wide default menu is identified by `(siteId, locale)`, not by `id === siteId`: a site with
 * more than one active locale needs a menu per locale, and each one's row id is a real, independently
 * generated uuid rather than something a caller can derive from the site id.
 */
describe(
  'navigation site-wide menu is locale-scoped (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let navigationModel: typeof import('./navigation.ts').navigation
    let pagesModel: typeof import('./pages.ts').pages
    let actor: PageActor

    before(async () => {
      fixtures = await setupTestDb()
      ;({ navigation: navigationModel } = await import('./navigation.ts'))
      ;({ pages: pagesModel } = await import('./pages.ts'))
      actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    })

    after(async () => {
      await teardownTestDb()
    })

    test('ensureSiteNav is idempotent for the same (siteId, locale) -- the single-locale case behaves as before', async () => {
      const first = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const second = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(first, second)
      assert.notEqual(first, fixtures.siteId)
    })

    test('ensureSiteNav returns a distinct row per locale of the same site', async () => {
      const enNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const frNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')
      assert.notEqual(enNavId, frNavId)
    })

    test("a newly created page's navigationId resolves to its own locale's site-wide row", async () => {
      const enPage = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'locale-scoped-en',
          title: 'Locale Scoped EN',
          editor: 'markdown',
          content: '# Hello',
          locale: 'en'
        },
        actor
      )
      const frPage = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'locale-scoped-fr',
          title: 'Locale Scoped FR',
          editor: 'markdown',
          content: '# Bonjour',
          locale: 'fr'
        },
        actor
      )

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const frSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')

      assert.equal(enPage.navigationId, enSiteNavId)
      assert.equal(frPage.navigationId, frSiteNavId)
      assert.notEqual(enPage.navigationId, frPage.navigationId)
    })

    test("the home page of each locale edits that locale's own site-wide menu", async () => {
      const enHome = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'home', title: 'Home', editor: 'markdown', content: '# Home', locale: 'en' },
        actor
      )
      const frHome = await pagesModel.createPage(
        fixtures.siteId,
        { path: 'home', title: 'Accueil', editor: 'markdown', content: '# Bonjour', locale: 'fr' },
        actor
      )

      const enResult = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: enHome.id,
        mode: 'override',
        items: [{ id: 'en-item', type: 'link', label: 'EN', target: '/' }]
      })
      const frResult = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: frHome.id,
        mode: 'override',
        items: [{ id: 'fr-item', type: 'link', label: 'FR', target: '/' }]
      })

      assert.notEqual(enResult.navigationId, frResult.navigationId)

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const frSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')
      assert.equal(enResult.navigationId, enSiteNavId)
      assert.equal(frResult.navigationId, frSiteNavId)

      const enItems = await navigationModel.getNav(fixtures.siteId, enSiteNavId, {
        actor: ADMIN_ACTOR,
        unfiltered: true
      })
      const frItems = await navigationModel.getNav(fixtures.siteId, frSiteNavId, {
        actor: ADMIN_ACTOR,
        unfiltered: true
      })
      assert.equal(enItems[0]!.label, 'EN')
      assert.equal(frItems[0]!.label, 'FR')
    })
  }
)

/**
 * `siteRoots` is what a "copy from" picker (Feature 359) lists to let an admin choose a source menu
 * without knowing a raw navigation uuid: the site-wide default's own row id for each of the site's
 * active locales, the same locale-scoped lookup `ensureSiteNav` provides one locale at a time.
 */
describe('navigation siteRoots (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('returns one root per active locale, matching what ensureSiteNav resolves for each', async () => {
    WIKI.sites[fixtures.siteId]!.config.locales.active = ['en', 'fr']

    const roots = await navigationModel.siteRoots(fixtures.siteId)

    assert.equal(roots.length, 2)
    const enExpected = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    const frExpected = await navigationModel.ensureSiteNav(fixtures.siteId, 'fr')
    assert.deepEqual(
      roots.sort((a, b) => a.locale.localeCompare(b.locale)),
      [
        { locale: 'en', navigationId: enExpected },
        { locale: 'fr', navigationId: frExpected }
      ]
    )
  })

  test('creates the row on demand for a locale that has never been edited', async () => {
    WIKI.sites[fixtures.siteId]!.config.locales.active = ['pt']

    const roots = await navigationModel.siteRoots(fixtures.siteId)

    assert.equal(roots.length, 1)
    assert.equal(roots[0]!.locale, 'pt')
    assert.notEqual(roots[0]!.navigationId, fixtures.siteId)
    const items = await navigationModel.getNav(fixtures.siteId, roots[0]!.navigationId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.deepEqual(items, [])
  })

  test('returns an empty array when the site has no active locales configured', async () => {
    WIKI.sites[fixtures.siteId]!.config.locales.active = undefined

    const roots = await navigationModel.siteRoots(fixtures.siteId)

    assert.deepEqual(roots, [])
  })
})

/**
 * `updateNavigation`'s `menuMode` param is a different axis from its `mode` param: `mode` is the
 * ENTRY's cascade setting (inherit/override/...), `menuMode` is the RESOLVED MENU ROW's own source
 * (static/auto/mixed). This is the wiring `NavEditMenu.vue`'s mode selector (Task 464) saves through.
 */
describe('navigation updateNavigation menuMode (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  test("sending menuMode sets the site-wide menu row's mode column and echoes it in the result", async () => {
    const home = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'home',
        title: 'Home',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    const result = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: home.id,
      mode: 'inherit',
      menuMode: 'auto'
    })

    assert.equal(result.mode, 'auto')
    assert.ok(result.navigationId)

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, result.navigationId!))
      .limit(1)
    assert.equal(rows[0]?.mode, 'auto')
  })

  test('sending menuMode without items leaves the stored items untouched', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'menu-mode-no-items-page',
        title: 'Menu Mode No Items Page',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    const items = [{ id: 'x', type: 'link' as const, label: 'Existing', target: '/' }]
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      items
    })

    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      menuMode: 'mixed'
    })

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode, items: navigationTable.items })
      .from(navigationTable)
      .where(eq(navigationTable.id, page.id))
      .limit(1)
    assert.equal(rows[0]?.mode, 'mixed')
    assert.deepEqual(rows[0]?.items, items)
  })

  test("leaving menuMode out does not change the row's existing mode", async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'menu-mode-untouched-page',
        title: 'Menu Mode Untouched Page',
        editor: 'markdown',
        content: '# Hello'
      },
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      menuMode: 'auto'
    })

    const result = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'overrideExact',
      items: [{ id: 'y', type: 'link' as const, label: 'Later', target: '/' }]
    })

    assert.equal(result.mode, undefined)
    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, page.id))
      .limit(1)
    assert.equal(rows[0]?.mode, 'auto')
  })
})

/**
 * `mode` (static/auto/mixed) is a column landed ahead of the tree-walk resolver that will read it --
 * this task only checks the schema default holds and that the column round-trips, not any resolution
 * behavior.
 */
describe('navigation.mode column (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('ensureSiteNav creates a row defaulting to static', async () => {
    const navId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')

    const rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, navId))
      .limit(1)

    assert.equal(rows[0]?.mode, 'static')
  })

  test('mode accepts auto and mixed', async () => {
    const navId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')

    await WIKI.db.update(navigationTable).set({ mode: 'auto' }).where(eq(navigationTable.id, navId))
    let rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, navId))
      .limit(1)
    assert.equal(rows[0]?.mode, 'auto')

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'mixed' })
      .where(eq(navigationTable.id, navId))
    rows = await WIKI.db
      .select({ mode: navigationTable.mode })
      .from(navigationTable)
      .where(eq(navigationTable.id, navId))
      .limit(1)
    assert.equal(rows[0]?.mode, 'mixed')
  })

  test('getMode reads the same column back, and defaults to static for a menu with no row yet', async () => {
    assert.equal(await navigationModel.getMode(fixtures.siteId, randomUUID()), 'static')

    const navId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'mixed' })
      .where(eq(navigationTable.id, navId))
    assert.equal(await navigationModel.getMode(fixtures.siteId, navId), 'mixed')

    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'static' })
      .where(eq(navigationTable.id, navId))
    assert.equal(await navigationModel.getMode(fixtures.siteId, navId), 'static')
  })

  /**
   * OpenProject #2127: `getMode()` used to select on `navigationTable.id` alone, so a
   * `site:navigation` delegate scoped to one site could pass an id belonging to a DIFFERENT site
   * and learn its mode. Every neighbouring method here (`getNav()`, `setNavItems()`, `copyNav()`)
   * already pairs `id` with `siteId`; this locks `getMode()` down the same way.
   */
  test('getMode does not return a row belonging to a different site', async () => {
    const [otherSite] = await WIKI.db
      .insert(sitesTable)
      .values({ hostname: `getmode-other-${randomUUID()}.example.com`, config: {} })
      .returning({ id: sitesTable.id })
    const otherNavId = await navigationModel.ensureSiteNav(otherSite!.id, 'en')
    await WIKI.db
      .update(navigationTable)
      .set({ mode: 'auto' })
      .where(eq(navigationTable.id, otherNavId))

    assert.equal(await navigationModel.getMode(otherSite!.id, otherNavId), 'auto')
    // -> Asked for with THIS test's own siteId instead -- must not see the other site's row
    assert.equal(await navigationModel.getMode(fixtures.siteId, otherNavId), 'static')

    // -> No site cleanup here: its nav row still references it (a bare site delete would 23503 on
    //    the FK), and this test's whole schema is dropped by teardownTestDb() regardless.
  })
})

/**
 * `generateFromTree` is SQL orchestration in the same shape as `tree.browse()` -- a join, an `EXISTS`
 * subquery and a comparator a mock of the query builder would mostly just be re-describing -- so this
 * runs the real method against a migrated, per-run-fresh database, same approach as the rest of this
 * file. Private on the class (it is not wired into `getNav` yet -- a later task in this feature does
 * that), so tests reach it through an `any` cast rather than TypeScript's own privacy, which is a
 * compile-time-only concept the test runtime does not enforce anyway.
 */
describe('navigation generateFromTree (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: any
  let pagesModel: typeof import('./pages.ts').pages
  let treeModel: typeof import('./tree.ts').tree
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ tree: treeModel } = await import('./tree.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'getting-started',
      title: 'Getting Started',
      editor: 'markdown',
      content: '# Hello\n\nSome content.',
      ...overrides
    }
  }

  function generate(rootFolderPath = '', locale = 'en'): Promise<NavigationItem[]> {
    return (navigationModel as any).generateFromTree(fixtures.siteId, rootFolderPath, locale, actor)
  }

  test('an empty subtree produces no items', async () => {
    const items = await generate('empty-subtree-root')
    assert.deepEqual(items, [])
  })

  test('a folder holding only unpublished/non-browsable pages is a dead end for a reader, but not for an actor who could populate it', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'unpublished-only/draft-page',
        title: 'Draft Page',
        publishState: 'draft'
      }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'unpublished-only/unbrowsable-page',
        title: 'Unbrowsable Page',
        isBrowsable: false
      }),
      actor
    )

    const groupsModel = (await import('./groups.ts')).groups
    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'allow-read-only-unpublished-check',
            name: 'Allow read only, everywhere',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          }
        ]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()
    const readerActor = { groupIds: [fixtures.groupId], permissions: [] }

    const readerItems = await (navigationModel as any).generateFromTree(
      fixtures.siteId,
      '',
      'en',
      readerActor
    )
    assert.equal(
      readerItems.some((item: NavigationItem) => item.label === 'unpublished-only'),
      false,
      'a reader with no way to populate the folder still sees it dropped as a dead end'
    )

    // -> OpenProject #2515: the same folder is NOT a dead end for an actor who could populate it --
    //    `manage:system` already means they could add or publish a page under this path right now,
    //    so it is kept as a childless leaf instead of being dropped the way the reader's view above
    //    still drops it.
    const managerItems = await generate()
    const folderItem = managerItems.find((item) => item.label === 'unpublished-only')
    assert.ok(folderItem, 'an actor who could populate the folder must still see it')
    assert.equal(folderItem!.children, undefined)
  })

  test('a nested override boundary is included as a leaf but not recursed into', async () => {
    const boundaryFolder = await treeModel.createFolder({
      parentPath: '',
      pathName: 'boundary-section',
      title: 'Boundary Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'boundary-section/inside-boundary', title: 'Inside Boundary' }),
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: boundaryFolder.id,
      mode: 'override'
    })

    // -> A sibling, non-boundary folder recurses normally, so the boundary's lack of children is
    //    contrasted against a case that walks all the way down
    await treeModel.createFolder({
      parentPath: '',
      pathName: 'plain-section',
      title: 'Plain Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'plain-section/inside-plain', title: 'Inside Plain' }),
      actor
    )

    const items = await generate()

    const boundaryItem = items.find((item) => item.label === 'Boundary Section')
    assert.ok(boundaryItem)
    assert.equal(boundaryItem!.children, undefined)

    const plainItem = items.find((item) => item.label === 'Plain Section')
    assert.ok(plainItem)
    assert.equal(plainItem!.children?.length, 1)
    assert.equal(plainItem!.children![0].label, 'Inside Plain')
    assert.equal(plainItem!.children![0].target, '/plain-section/inside-plain')
  })

  test('a generated item carries its own tree path and containing folderId', async () => {
    const sectionFolder = await treeModel.createFolder({
      parentPath: '',
      pathName: 'path-fields-section',
      title: 'Path Fields Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'path-fields-section/inside-page', title: 'Inside Page' }),
      actor
    )

    const items = await generate()
    const folderItem = items.find((item) => item.label === 'Path Fields Section')
    assert.ok(folderItem)
    assert.equal(folderItem!.path, 'path-fields-section')
    assert.equal(folderItem!.folderId, null)

    const pageItem = folderItem!.children?.find((item) => item.label === 'Inside Page')
    assert.ok(pageItem)
    assert.equal(pageItem!.path, 'path-fields-section/inside-page')
    assert.equal(pageItem!.folderId, sectionFolder.id)
  })

  test('a hide boundary drops the entry and everything below it', async () => {
    const hiddenFolder = await treeModel.createFolder({
      parentPath: '',
      pathName: 'hidden-section',
      title: 'Hidden Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'hidden-section/inside-hidden', title: 'Inside Hidden' }),
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: hiddenFolder.id,
      mode: 'hide'
    })

    const items = await generate()
    assert.equal(
      items.some((item) => item.label === 'Hidden Section'),
      false
    )
  })

  test("a page link is unprefixed at the site's primary locale, with forcePrefix off", async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'unprefixed-locale-page', title: 'Unprefixed Locale Page' }),
      actor
    )

    const items = await generate('', 'en')
    const item = items.find((i) => i.label === 'Unprefixed Locale Page')
    assert.ok(item)
    assert.equal(item!.target, '/unprefixed-locale-page')
  })

  test('a page link is locale-prefixed when generated for a non-primary active locale', async () => {
    await treeModel.createFolder({
      parentPath: '',
      pathName: 'french-section',
      title: 'French Section',
      locale: 'fr',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'french-section/page-fr', title: 'Page FR', locale: 'fr' }),
      actor
    )

    const items = await generate('', 'fr')
    const item = items.find((i) => i.label === 'French Section')
    assert.ok(item)
    assert.equal(item!.children?.length, 1)
    assert.equal(item!.children![0].target, '/fr/french-section/page-fr')
  })

  /**
   * OpenProject #2155: an auto/mixed menu used to run no page-rule check at all -- every published,
   * browsable page in the walked subtree reached the caller regardless of a path/tag/classification
   * DENY. These lock down the fix: a denied page never appears, and a folder left with nothing
   * visible under it (once the actor's own rules are applied) is dropped as a dead end, the same
   * way `holdsVisiblePages` already drops one with no visible descendant at all.
   */
  test('a guest actor never sees an entry under a path DENY, and the emptied folder is dropped too', async () => {
    const groupsModel = (await import('./groups.ts')).groups
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'denied-section/secret-page', title: 'Secret Page' }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'open-page', title: 'Open Page' }),
      actor
    )

    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'allow-all',
            name: 'Allow all',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          },
          {
            id: 'deny-secret',
            name: 'Deny secret section',
            roles: ['read:pages'],
            match: 'START',
            mode: 'DENY',
            path: 'denied-section',
            locales: [],
            sites: []
          }
        ]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const guestActor = { groupIds: [fixtures.groupId], permissions: [] }
    const items = await (navigationModel as any).generateFromTree(
      fixtures.siteId,
      '',
      'en',
      guestActor
    )

    assert.equal(
      items.some((item: NavigationItem) => item.label === 'Open Page'),
      true,
      'an unrelated, allowed page must still appear'
    )
    // -> The folder auto-created for the denied page's own path segment is titled with that raw
    //    segment (`createFolder`'s `title: fileName` -- there is no humanization step). Matched by
    //    that literal id/label rather than a guessed, humanized title -- and checked for absence
    //    among top-level items rather than an exact list, since this describe block's tree
    //    accumulates content across its other tests too (no per-test cleanup).
    assert.equal(
      items.some((item: NavigationItem) => item.label === 'denied-section'),
      false,
      'the folder holding only denied content must not appear at all'
    )
    assert.equal(
      items.some((item: NavigationItem) => item.label === 'Secret Page'),
      false,
      'the denied page itself must never appear, even nested'
    )
    // -> Sanity check against the same rules through the real engine: the section itself is
    //    genuinely denied, not merely absent from this particular tree shape
    assert.equal(
      groupsModel.checkAccess(guestActor, 'read:pages', {
        path: 'denied-section/secret-page',
        locale: 'en',
        siteId: fixtures.siteId,
        classification: null
      }),
      false
    )
  })

  test('unfiltered skips the read:pages check entirely, matching the visibility-group pass it already skips', async () => {
    const groupsModel = (await import('./groups.ts')).groups
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'unfiltered-check-section/page',
        title: 'Unfiltered Check Page'
      }),
      actor
    )
    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'deny-unfiltered-section',
            name: 'Deny everything',
            roles: ['read:pages'],
            match: 'START',
            mode: 'DENY',
            path: '',
            locales: [],
            sites: []
          }
        ]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const blockedActor = { groupIds: [fixtures.groupId], permissions: [] }
    const filtered = await (navigationModel as any).generateFromTree(
      fixtures.siteId,
      '',
      'en',
      blockedActor
    )
    const unfilteredResult = await (navigationModel as any).generateFromTree(
      fixtures.siteId,
      '',
      'en',
      null
    )

    // -> A blanket root DENY means the filtered walk finds nothing at all, regardless of how much
    //    the tree already holds from earlier tests in this describe block...
    assert.deepEqual(filtered, [])
    // -> ...while the unfiltered walk (an editor's "full" preview) still shows the real structure,
    //    the same reasoning `isVisibleTo` is already skipped for -- including the page this test
    //    itself just created, proving the check was genuinely skipped rather than the tree being
    //    coincidentally empty.
    assert.ok(unfilteredResult.length > 0)
  })

  /**
   * OpenProject #2515: an empty folder used to be dropped from the generated nav for every viewer
   * alike, including the author who just created it and holds `write:pages`/`manage:pages` right
   * there -- for them it isn't a dead end, it's an empty container waiting to be used. These lock
   * down the fix without disturbing the existing dead-end behavior for anyone who genuinely
   * couldn't populate the folder.
   */
  test('an actor holding write:pages over an otherwise-empty folder still sees it, as a childless leaf', async () => {
    const groupsModel = (await import('./groups.ts')).groups
    await treeModel.createFolder({
      parentPath: '',
      pathName: 'freshly-created-empty-folder',
      title: 'Freshly Created Empty Folder',
      locale: 'en',
      siteId: fixtures.siteId
    })

    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'allow-write-empty-folder',
            name: 'Allow read/write on the new folder',
            roles: ['read:pages', 'write:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: 'freshly-created-empty-folder',
            locales: [],
            sites: []
          }
        ]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const authorActor = { groupIds: [fixtures.groupId], permissions: [] }
    const items = await (navigationModel as any).generateFromTree(
      fixtures.siteId,
      '',
      'en',
      authorActor
    )

    const folderItem = items.find(
      (item: NavigationItem) => item.label === 'Freshly Created Empty Folder'
    )
    assert.ok(folderItem, 'the empty folder must appear for the actor who can populate it')
    assert.equal(folderItem!.children, undefined)
  })

  test('a reader with read:pages but no write access to an otherwise-empty folder does not see it', async () => {
    const groupsModel = (await import('./groups.ts')).groups
    await treeModel.createFolder({
      parentPath: '',
      pathName: 'empty-folder-reader-only',
      title: 'Empty Folder Reader Only',
      locale: 'en',
      siteId: fixtures.siteId
    })

    await fixtures.db
      .update(groupsTable)
      .set({
        rules: [
          {
            id: 'allow-read-only',
            name: 'Allow read only, everywhere',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          }
        ]
      })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const readerActor = { groupIds: [fixtures.groupId], permissions: [] }
    const items = await (navigationModel as any).generateFromTree(
      fixtures.siteId,
      '',
      'en',
      readerActor
    )

    assert.equal(
      items.some((item: NavigationItem) => item.label === 'Empty Folder Reader Only'),
      false,
      'an empty folder must stay a dead end for a reader who could never populate it'
    )
  })

  test('an unfiltered read (the nav editor preview) shows an otherwise-empty folder too', async () => {
    await treeModel.createFolder({
      parentPath: '',
      pathName: 'empty-folder-unfiltered-preview',
      title: 'Empty Folder Unfiltered Preview',
      locale: 'en',
      siteId: fixtures.siteId
    })

    const items = await (navigationModel as any).generateFromTree(fixtures.siteId, '', 'en', null)

    const folderItem = items.find(
      (item: NavigationItem) => item.label === 'Empty Folder Unfiltered Preview'
    )
    assert.ok(folderItem, 'an unfiltered read must show the real structure, empty folders included')
    assert.equal(folderItem!.children, undefined)
  })
})

/**
 * `getNav`'s mode branch: this is what wires `generateFromTree` in, so it runs against a real,
 * migrated database like the rest of this file's SQL-orchestration-heavy suites, rather than mocking
 * the query builder.
 */
describe('navigation getNav mode resolution (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  async function setMode(navId: string, mode: 'static' | 'auto' | 'mixed') {
    await WIKI.db.update(navigationTable).set({ mode }).where(eq(navigationTable.id, navId))
  }

  test('static mode returns the stored items unchanged, unaffected by mode wiring', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    const items: NavigationItem[] = [{ id: 'a', type: 'link', label: 'Hand-authored', target: '/' }]
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, items)
    await setMode(siteNavId, 'static')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.deepEqual(result, items)
  })

  test('auto mode ignores stored items and returns the tree walk from the site root', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'auto-mode-page',
        title: 'Auto Mode Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, [
      { id: 'stale', type: 'link', label: 'Should not appear', target: '/' }
    ])
    await setMode(siteNavId, 'auto')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.equal(
      result.some((item) => item.label === 'Should not appear'),
      false
    )
    const generated = result.find((item) => item.label === 'Auto Mode Page')
    assert.ok(generated)
    assert.equal(generated!.target, '/auto-mode-page')
  })

  test('auto mode still applies visibility-group filtering on top of generated items', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel
      .createPage(
        fixtures.siteId,
        {
          path: 'auto-mode-page',
          title: 'Auto Mode Page',
          editor: 'markdown',
          content: '# Hello'
        },
        { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
      )
      .catch(() => {}) // -> May already exist from the previous test in this describe; irrelevant here
    await setMode(siteNavId, 'auto')

    // -> Generated items never carry `visibilityGroups`, so they are always visible -- this just
    //    confirms the filtering pass runs at all (it would throw/behave differently on `unfiltered`
    //    input shaped unexpectedly) and that `unfiltered` still returns the same generated set
    const filtered = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR,
      userGroups: []
    })
    const full = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR,
      unfiltered: true
    })
    assert.deepEqual(
      filtered.map((i) => i.id),
      full.map((i) => i.id)
    )
  })

  test('mixed mode merges generated items with pinned stored items, defaulting unpinned ones to after', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'mixed-mode-page',
        title: 'Mixed Mode Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, [
      { id: 'pinned-before', type: 'link', label: 'Pinned Before', target: '/', pinned: 'before' },
      { id: 'unpinned', type: 'link', label: 'Unpinned', target: '/' },
      { id: 'pinned-after', type: 'link', label: 'Pinned After', target: '/', pinned: 'after' }
    ])
    await setMode(siteNavId, 'mixed')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    const ids = result.map((i) => i.id)
    const generatedIndex = result.findIndex((i) => i.label === 'Mixed Mode Page')

    assert.equal(ids[0], 'pinned-before')
    assert.ok(generatedIndex > 0, 'generated item comes after the pinned-before item')
    // -> Unpinned and explicitly-'after' stored items both land after every generated item
    assert.ok(ids.indexOf('unpinned') > generatedIndex)
    assert.equal(ids[ids.length - 1], 'pinned-after')
    assert.equal(ids[ids.length - 2], 'unpinned')
  })

  test("a tree-entry-owned auto menu generates from that entry's own folderPath (its siblings), not its own subtree", async () => {
    const overriddenPage = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'sibling-scope/override-target',
        title: 'Override Target',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'sibling-scope/sibling-page',
        title: 'Sibling Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: overriddenPage.id,
      mode: 'override',
      items: []
    })
    await setMode(overriddenPage.id, 'auto')

    const result = await navigationModel.getNav(fixtures.siteId, overriddenPage.id, {
      actor: ADMIN_ACTOR
    })
    const labels = result.map((i) => i.label)
    assert.ok(labels.includes('Override Target'))
    assert.ok(labels.includes('Sibling Page'))
  })

  /**
   * OpenProject #2442: a page/folder-level override's generated menu resolves to the override's own
   * section root (its siblings, per the test just above), not the locale root -- so a TOP-LEVEL
   * generated item's own `folderId` must be that section's folder id, and `getNavRoot` must hand the
   * same path/id back for the sidebar's own root-level "create here" action to target. Both used to
   * be wrong: `generateFromTree`'s initial call always defaulted `parentFolderId` to `null`
   * regardless of `rootFolderPath`, and there was no `getNavRoot` at all.
   */
  test("an override's generated top-level items and getNavRoot both resolve to the override's own section root, not the locale root", async () => {
    const [sectionFolder] = await WIKI.db
      .select()
      .from(treeTable)
      .where(
        and(
          eq(treeTable.siteId, fixtures.siteId),
          eq(treeTable.locale, 'en'),
          eq(treeTable.type, 'folder'),
          eq(treeTable.folderPath, ''),
          eq(treeTable.fileName, 'sibling-scope')
        )
      )
      .limit(1)
    // -> Created by the previous test's page, which auto-creates its own containing folder --
    //    confirmed present rather than re-created, so a fixture ordering change fails loudly here
    //    instead of silently asserting against `undefined`.
    assert.ok(sectionFolder, "expected the 'sibling-scope' folder auto-created above to exist")

    const overriddenPage = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'sibling-scope/root-fix-target',
        title: 'Root Fix Target',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: overriddenPage.id,
      mode: 'override',
      items: []
    })
    await setMode(overriddenPage.id, 'auto')

    const items = await navigationModel.getNav(fixtures.siteId, overriddenPage.id, {
      actor: ADMIN_ACTOR
    })
    for (const item of items) {
      assert.equal(
        item.folderId,
        sectionFolder!.id,
        `expected top-level item "${item.label}" to carry the section's own folderId, not the locale root's null`
      )
    }

    const root = await navigationModel.getNavRoot(fixtures.siteId, overriddenPage.id)
    assert.deepEqual(root, { rootPath: 'sibling-scope', rootId: sectionFolder!.id })
  })

  test("getNavRoot resolves the site-wide default menu's root as the locale root (empty path, null id)", async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    const root = await navigationModel.getNavRoot(fixtures.siteId, siteNavId)
    assert.deepEqual(root, { rootPath: '', rootId: null })
  })

  test('a nonexistent menu id returns an empty list rather than throwing', async () => {
    const result = await navigationModel.getNav(fixtures.siteId, crypto.randomUUID(), {
      actor: ADMIN_ACTOR
    })
    assert.deepEqual(result, [])
  })

  test('getNavRoot mirrors getNav for a nonexistent menu id: resolves to the empty root rather than throwing', async () => {
    const root = await navigationModel.getNavRoot(fixtures.siteId, crypto.randomUUID())
    assert.deepEqual(root, { rootPath: '', rootId: null })
  })

  test('auto mode tags every generated item as generated, which static mode never does', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'generated-flag-page',
        title: 'Generated Flag Page',
        editor: 'markdown',
        content: '# Hello'
      },
      { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    )
    await setMode(siteNavId, 'auto')
    const auto = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.ok(auto.length > 0)
    assert.ok(auto.every((item) => item.generated === true))

    await setMode(siteNavId, 'static')
    const staticResult = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.ok(staticResult.every((item) => item.generated === undefined))
  })

  test('mixed mode tags only the generated block, leaving stored items untagged', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel
      .createPage(
        fixtures.siteId,
        {
          path: 'generated-flag-page',
          title: 'Generated Flag Page',
          editor: 'markdown',
          content: '# Hello'
        },
        { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
      )
      .catch(() => {}) // -> May already exist from the previous test in this describe; irrelevant here
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, [
      { id: 'stored-before', type: 'link', label: 'Stored Before', target: '/', pinned: 'before' },
      { id: 'stored-after', type: 'link', label: 'Stored After', target: '/' }
    ])
    await setMode(siteNavId, 'mixed')

    const result = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    const stored = result.filter((i) => i.id === 'stored-before' || i.id === 'stored-after')
    const generated = result.filter((i) => i.label === 'Generated Flag Page')

    assert.ok(stored.length === 2)
    assert.ok(stored.every((item) => item.generated === undefined))
    assert.ok(generated.length > 0)
    assert.ok(generated.every((item) => item.generated === true))
  })
})

/**
 * OpenProject #2155: `generateFromTree` never asked the page-rule engine anything before this feature
 * -- an `auto`/`mixed` menu's entries came straight from `pageIsVisible` (browsable + published) with
 * no `read:pages` check at all, so a plain path DENY, or a `CLASSIFICATION` DENY, leaked through an
 * unauthenticated `GET .../navigation/:navId` the same as anything else in the tree. These assert the
 * fix: a reader denied `read:pages` on an entry never sees it generated, an authorized reader still
 * does, and a folder left with nothing visible under it (because every descendant was individually
 * denied, not because none existed) is dropped rather than shown as an empty dead end.
 */
describe(
  'navigation getNav read:pages filtering (DB-backed, OpenProject #2155)',
  {
    skip: !hasTestDatabase()
  },
  () => {
    let fixtures: TestFixtures
    let navigationModel: typeof import('./navigation.ts').navigation
    let pagesModel: typeof import('./pages.ts').pages
    let groupsModel: typeof import('./groups.ts').groups
    let adminActor: PageActor
    let deniedActor: AccessActor
    let restrictedClassificationId: string

    before(async () => {
      fixtures = await setupTestDb()
      ;({ navigation: navigationModel } = await import('./navigation.ts'))
      ;({ pages: pagesModel } = await import('./pages.ts'))
      ;({ groups: groupsModel } = await import('./groups.ts'))
      adminActor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }

      const restrictedLevel = await WIKI.models.classificationLevels.create({
        name: 'Filtering Test Restricted'
      })
      restrictedClassificationId = restrictedLevel.id

      // -> Broadly allows read:pages, then carves out a path DENY and a classification DENY on top --
      //    exactly the "a plain path DENY leaks here too" and "a classification DENY leaks here too"
      //    scenarios #2150/#2155 describe.
      const [group] = await WIKI.db
        .insert(groupsTable)
        .values({
          name: 'Filtering Test Denied Reader',
          permissions: ['read:pages'],
          rules: [
            {
              id: randomUUID(),
              name: 'broad allow',
              roles: ['read:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            },
            {
              id: randomUUID(),
              name: 'path deny',
              roles: ['read:pages'],
              match: 'START',
              mode: 'DENY',
              path: 'denied-path',
              locales: [],
              sites: []
            },
            {
              id: randomUUID(),
              name: 'classification deny',
              roles: ['read:pages'],
              match: 'CLASSIFICATION',
              mode: 'DENY',
              path: '',
              locales: [],
              sites: [],
              classifications: [restrictedClassificationId]
            }
          ]
        })
        .returning({ id: groupsTable.id })
      deniedActor = { groupIds: [group!.id], permissions: [] }
      await groupsModel.reloadCache()
    })

    after(async () => {
      await teardownTestDb()
    })

    async function autoMenu(): Promise<string> {
      const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      await WIKI.db
        .update(navigationTable)
        .set({ mode: 'auto' })
        .where(eq(navigationTable.id, siteNavId))
      return siteNavId
    }

    test('a path DENY omits the entry, and drops the folder left with nothing visible under it', async () => {
      const siteNavId = await autoMenu()
      await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'denied-path/secret-page',
          title: 'Secret Page',
          editor: 'markdown',
          content: '# Hello'
        },
        adminActor
      )

      const asDenied = await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: deniedActor
      })
      assert.equal(
        asDenied.some((item) => item.label === 'Secret Page'),
        false
      )
      // -> The folder holding only that page is a dead end for this reader -- dropped, not shown empty
      assert.equal(
        asDenied.some((item) => item.label === 'denied-path'),
        false
      )

      const asAuthorized = await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: adminActor
      })
      const folder = asAuthorized.find((item) => item.label === 'denied-path')
      assert.ok(folder)
      assert.ok(folder!.children?.some((c) => c.label === 'Secret Page'))
    })

    test('a classification DENY omits the entry for a denied reader, but not an authorized one', async () => {
      const siteNavId = await autoMenu()
      await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'classified-page',
          title: 'Classified Page',
          editor: 'markdown',
          content: '# Hello',
          classification: restrictedClassificationId
        },
        adminActor
      )

      const asDenied = await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: deniedActor
      })
      assert.equal(
        asDenied.some((item) => item.label === 'Classified Page'),
        false
      )

      const asAuthorized = await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: adminActor
      })
      assert.ok(asAuthorized.some((item) => item.label === 'Classified Page'))
    })

    test('unfiltered (editor preview) reads skip the read:pages check entirely', async () => {
      const siteNavId = await autoMenu()
      await pagesModel
        .createPage(
          fixtures.siteId,
          {
            path: 'denied-path/secret-page',
            title: 'Secret Page',
            editor: 'markdown',
            content: '# Hello'
          },
          adminActor
        )
        .catch(() => {}) // -> May already exist from an earlier test in this describe; irrelevant here

      const full = await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: deniedActor,
        unfiltered: true
      })
      assert.ok(full.some((item) => item.label === 'denied-path'))
    })
  }
)

/** The mode/cascade combination `updateNavigation()` should produce for a top-level entry. */
function expectedTransition(
  mode: NavigationMode,
  wasCascading: boolean,
  ancestorId: string,
  ownNavId: string
): { navId: string | null; cascadeTo: string | null | undefined } {
  switch (mode) {
    case 'inherit':
      return { navId: ancestorId, cascadeTo: wasCascading ? ancestorId : undefined }
    case 'override':
      return { navId: ownNavId, cascadeTo: ownNavId }
    case 'overrideExact':
      return { navId: ownNavId, cascadeTo: wasCascading ? ancestorId : undefined }
    case 'hide':
      return { navId: null, cascadeTo: null }
    case 'hideExact':
      return { navId: null, cascadeTo: wasCascading ? ancestorId : undefined }
  }
}

/**
 * `models/navigation.ts` is almost entirely SQL — a menu lookup, an ancestor-cascade query written in
 * raw `ltree` operators, and a tree-entry update coordinated with it — so this runs the real methods
 * against a migrated, per-run-fresh database (see `test/db.ts`) rather than mocking the query builder.
 *
 * Doubles as the proof that the shared DB fixture is sufficient for `models/navigation.ts` to run:
 * standing that up is this task's actual deliverable (Feature 361, task 465), and `seedTreeEntry()` is
 * the fixture helper it adds for every later task in this Feature to build on.
 */
describe('navigation (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /**
   * A real `navigation` row's id -- `tree.navigationId` has an FK against it (`ON DELETE SET NULL`,
   * task 2100/db/migrations/20260825202930_main), so a sentinel used only to distinguish which
   * ancestor's id `inheritedNavId()`/a cascade update resolved to must still be a row that exists,
   * not a bare `randomUUID()` (which now fails the insert outright). Its `items` are never read by
   * these tests, only its `id`.
   */
  async function createNavId(): Promise<string> {
    const [nav] = await fixtures.db
      .insert(navigationTable)
      .values({ siteId: fixtures.siteId, items: [] })
      .returning({ id: navigationTable.id })
    return nav!.id
  }

  const items: NavigationItem[] = [
    { id: 'a', type: 'link', label: 'Everyone', target: '/everyone' },
    { id: 'b', type: 'link', label: 'Admins only', target: '/admins', visibilityGroups: ['admins'] }
  ]

  test('ensureSiteNav creates an empty menu once, idempotently', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    assert.deepEqual(
      await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: ADMIN_ACTOR,
        unfiltered: true
      }),
      []
    )

    // -> A page's menu is saved before ensureSiteNav would run again for the same locale (e.g. a
    //    second edit); onConflictDoNothing is what keeps that second call from wiping it back to
    //    empty.
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: (await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'home' })).id,
      mode: 'inherit',
      items
    })
    const sameSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    assert.equal(sameSiteNavId, siteNavId)
    assert.deepEqual(
      await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: ADMIN_ACTOR,
        unfiltered: true
      }),
      items
    )
  })

  test('getNav filters items and their children by visibility group', async () => {
    const page = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'filtered-page'
    })
    const { navigationId } = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      items
    })
    assert.equal(navigationId, page.id)

    const asGuest = await navigationModel.getNav(fixtures.siteId, navigationId!, {
      actor: ADMIN_ACTOR,
      userGroups: []
    })
    assert.deepEqual(
      asGuest.map((i) => i.id),
      ['a']
    )

    const asAdmin = await navigationModel.getNav(fixtures.siteId, navigationId!, {
      actor: ADMIN_ACTOR,
      userGroups: ['admins']
    })
    assert.deepEqual(
      asAdmin.map((i) => i.id),
      ['a', 'b']
    )
  })

  test('getNav refuses a menu id that belongs to a different site (OpenProject #941)', async () => {
    const [otherSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: `test-${randomUUID()}.localhost`,
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const otherSiteId = otherSite!.id
    const otherNavId = await navigationModel.ensureSiteNav(otherSiteId, 'en')
    const secretItems: NavigationItem[] = [
      { id: 'secret', type: 'link', label: 'Secret', target: '/secret' }
    ]
    await navigationModel.setNavItems(otherSiteId, otherNavId, secretItems)

    // -> The row is real and readable under its own site...
    assert.deepEqual(
      await navigationModel.getNav(otherSiteId, otherNavId, {
        actor: ADMIN_ACTOR,
        unfiltered: true
      }),
      secretItems
    )
    // -> ...but a caller holding only `fixtures.siteId`'s id cannot read it by guessing/reusing the
    //    row id under the wrong site, the same way `setNavItems`/`copyNav`'s writes already refuse to.
    assert.deepEqual(
      await navigationModel.getNav(fixtures.siteId, otherNavId, {
        actor: ADMIN_ACTOR,
        unfiltered: true
      }),
      []
    )
  })

  test('updateNavigation on a folder with mode=override cascades to inheriting descendants', async () => {
    const folder = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'docs',
      type: 'folder'
    })
    const child = await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'docs/child' })

    const { navigationId } = await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: folder.id,
      mode: 'override',
      items
    })

    assert.equal(navigationId, folder.id)
    assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, child.id), folder.id)
  })

  test('updateNavigation rejects a page id that does not exist', async () => {
    await assert.rejects(
      navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: '00000000-0000-0000-0000-000000000000',
        mode: 'inherit'
      }),
      /does not exist/
    )
  })

  /**
   * `ancestorNavId()` (private) is the ltree cascade query at the heart of the model; it is only
   * reachable through its public wrapper `inheritedNavId()`, which just resolves the calling entry's
   * `folderPath` first. These seed a tree by hand (rather than going through `updateNavigation`, which
   * exercises the same query indirectly above) so each case isolates exactly one thing the raw SQL has
   * to get right.
   */
  describe('inheritedNavId / ancestorNavId resolution', () => {
    test('a root-level page (empty folderPath) resolves to the site menu without querying tree', async (t) => {
      const executeSpy = t.mock.method(fixtures.db, 'execute')
      const root = await seedTreeEntry(fixtures.db, { siteId: fixtures.siteId, path: 'root-page' })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, root.id)

      // -> The site's own nav row id for this entry's locale — never `siteId` itself, per
      //    `ensureSiteNav`'s own contract (locale-scoped site menus, #990).
      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(result, enSiteNavId)
      // -> `ancestorNavId` short-circuits on an empty folderPath before ever building the ltree query;
      //    `getEntry`'s own lookup goes through the query builder, not `db.execute`, so a call here
      //    would only come from the raw-SQL branch this case must not reach.
      assert.equal(executeSpy.mock.callCount(), 0)
    })

    test('a page with no overriding/hiding ancestor anywhere above it falls back to the site menu', async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'plain-branch',
        type: 'folder'
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'plain-branch/leaf'
      })
      // -> Sanity: the ancestor really is on the default mode, not incidentally excluded some other way
      assert.equal(folder.navigationMode, 'inherit')

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), enSiteNavId)
    })

    test("exactly one overriding ancestor: resolves to that ancestor's navigationId", async () => {
      const overrideNavId = await createNavId()
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-branch',
        type: 'folder',
        navigationMode: 'override',
        navigationId: overrideNavId
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-branch/leaf'
      })

      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), overrideNavId)
      assert.notEqual(overrideNavId, folder.id)
    })

    test("exactly one hiding ancestor: resolves to that ancestor's (null) navigationId, not the site menu", async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hide-branch',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hide-branch/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, page.id)

      // -> Must be exactly null (a hidden sidebar), not coerced to the site id the way "no match at
      //    all" is. `assert.equal` would let `undefined` slip through here just as easily as `null`.
      assert.strictEqual(result, null)
      assert.notEqual(result, fixtures.siteId)
      void folder
    })

    test('two overriding/hiding ancestors at different depths: the nearer one wins', async () => {
      const farNavId = await createNavId()
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels',
        type: 'folder',
        navigationMode: 'override',
        navigationId: farNavId
      })
      // -> The nearer ancestor hides rather than overrides, so a wrong answer here can't be mistaken
      //    for "picked some override" — it has to specifically be the deeper row's null, not the
      //    shallower row's navigationId, and ORDER BY nlevel(...) DESC is what makes that true instead
      //    of depending on whichever row postgres happens to scan first.
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels/nested',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const leaf = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'levels/nested/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, leaf.id)

      assert.strictEqual(result, null)
      assert.notEqual(result, farNavId)
    })

    test('a sibling subtree that overrides does not affect a page under a different branch', async () => {
      const siblingNavId = await createNavId()
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-a',
        type: 'folder',
        navigationMode: 'override',
        navigationId: siblingNavId
      })
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-b',
        type: 'folder'
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'branch-b/leaf'
      })

      const result = await navigationModel.inheritedNavId(fixtures.siteId, page.id)

      const enSiteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(result, enSiteNavId)
      assert.notEqual(result, siblingNavId)
    })
  })

  /**
   * The mode-transition matrix (navigation.ts:220-284): every `NAVIGATION_MODES` value, arrived at
   * from a prior mode that cascaded (`override`) and one that didn't (`inherit`), checking the
   * persisted `navigationMode`/`navigationId` on the entry itself and, via a seeded `inherit` child,
   * whether a cascade `UPDATE` ran at all — not just what `cascadeTo` computes to internally.
   *
   * Every case seeds a fresh top-level folder (`folderPath === ''`), so `ancestorNavId` always
   * resolves to `fixtures.siteId` without depending on the ltree query already covered above, and
   * `ownNavId` is always the folder's own id (never the site-root special case, covered separately
   * below). The child starts on a random sentinel `navigationId` that matches neither candidate, so
   * "cascade did not touch it" and "cascade set it to X" are never ambiguous.
   */
  describe('updateNavigation mode-transition matrix', () => {
    const priorByCategory = { cascading: 'override', noncascading: 'inherit' } as const

    for (const mode of NAVIGATION_MODES) {
      for (const [category, priorMode] of Object.entries(priorByCategory) as [
        keyof typeof priorByCategory,
        NavigationMode
      ][]) {
        test(`${priorMode} (${category} prior) -> ${mode}`, async () => {
          const wasCascading = category === 'cascading'
          const slug = `matrix-${mode}-${category}`
          const folder = await seedTreeEntry(fixtures.db, {
            siteId: fixtures.siteId,
            path: slug,
            type: 'folder',
            navigationMode: priorMode,
            navigationId: priorMode === 'override' ? await createNavId() : null
          })
          const sentinelNavId = await createNavId()
          const child = await seedTreeEntry(fixtures.db, {
            siteId: fixtures.siteId,
            path: `${slug}/child`,
            navigationMode: 'inherit',
            navigationId: sentinelNavId
          })

          // -> The root folder has no overriding/hiding ancestor of its own, so it falls back to the
          //    site's locale-scoped nav row — never `fixtures.siteId` itself (`ensureSiteNav`'s
          //    contract, #990).
          const ancestorId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
          const ownNavId = folder.id
          const { navId: expectedNavId, cascadeTo: expectedCascadeTo } = expectedTransition(
            mode,
            wasCascading,
            ancestorId,
            ownNavId
          )

          const result = await navigationModel.updateNavigation({
            siteId: fixtures.siteId,
            pageId: folder.id,
            mode
          })

          assert.equal(result.navigationMode, mode)
          assert.equal(result.navigationId, expectedNavId)

          const [persistedFolder] = await fixtures.db
            .select()
            .from(treeTable)
            .where(eq(treeTable.id, folder.id))
          assert.equal(persistedFolder!.navigationMode, mode)
          assert.equal(persistedFolder!.navigationId, expectedNavId)

          const [persistedChild] = await fixtures.db
            .select()
            .from(treeTable)
            .where(eq(treeTable.id, child.id))
          if (expectedCascadeTo === undefined) {
            // -> No cascade UPDATE ran at all: the child's navigationId is exactly what it was
            //    seeded with, not merely "unchanged from some computed value".
            assert.equal(persistedChild!.navigationId, sentinelNavId)
          } else {
            assert.equal(persistedChild!.navigationId, expectedCascadeTo)
          }
          // -> Cascade never touches the mode column, only navigationId.
          assert.equal(persistedChild!.navigationMode, 'inherit')
        })
      }
    }
  })

  /**
   * The cascade `UPDATE` (navigation.ts:260-284) in isolation from the mode-decision logic already
   * covered above: each case builds its own multi-level tree (at least 3 levels deep, with a branch
   * and a sub-branch) and asserts directly against the persisted `tree` rows, since the cascade's
   * entire effect is on rows `updateNavigation()` never returns.
   */
  describe('cascade UPDATE across a multi-level tree', () => {
    test('(a) override cascades navigationId to every inherit-mode descendant beneath it, at every depth', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root',
        type: 'folder'
      })
      const branch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch',
        type: 'folder'
      })
      const subBranch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch/sub',
        type: 'folder'
      })
      const leaf = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch/sub/leaf'
      })
      const siblingLeaf = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-a-root/branch/sibling-leaf'
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      for (const entry of [branch, subBranch, leaf, siblingLeaf]) {
        const [row] = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, entry.id))
        assert.equal(
          row!.navigationId,
          navigationId,
          `${entry.fileName} should pick up the cascade`
        )
        assert.equal(row!.navigationMode, 'inherit')
      }
    })

    test('(b) a nearer override/hide several levels down blocks the cascade for itself and everything beneath it', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root',
        type: 'folder'
      })
      const branch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch',
        type: 'folder'
      })

      const nearerOverrideNavId = await createNavId()
      const nearerOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-override',
        type: 'folder',
        navigationMode: 'override',
        navigationId: nearerOverrideNavId
      })
      const belowOverrideSentinel = await createNavId()
      const belowOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-override/child',
        type: 'folder',
        navigationId: belowOverrideSentinel
      })
      const deeperBelowOverrideSentinel = await createNavId()
      const deeperBelowOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-override/child/grandchild',
        navigationId: deeperBelowOverrideSentinel
      })

      const nearerHide = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-hide',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const belowHideSentinel = await createNavId()
      const belowHide = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-b-root/branch/nearer-hide/child',
        navigationId: belowHideSentinel
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      // -> branch itself has no nearer override/hide above it (other than root, the source of the
      //    cascade), so it picks up the cascade normally.
      const [branchRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, branch.id))
      assert.equal(branchRow!.navigationId, navigationId)

      // -> The nearer-override entry's own row: excluded outright by the WHERE clause's
      //    navigationMode = 'inherit' filter, since its mode is 'override', not touched by this
      //    ancestor's cascade.
      const [nearerOverrideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, nearerOverride.id))
      assert.equal(nearerOverrideRow!.navigationId, nearerOverrideNavId)
      assert.equal(nearerOverrideRow!.navigationMode, 'override')

      // -> Everything beneath the nearer override — the NOT EXISTS guard's actual job — stays
      //    exactly as seeded, at both depths.
      const [belowOverrideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, belowOverride.id))
      assert.equal(belowOverrideRow!.navigationId, belowOverrideSentinel)

      const [deeperRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, deeperBelowOverride.id))
      assert.equal(deeperRow!.navigationId, deeperBelowOverrideSentinel)

      // -> Same guard, but for a nearer 'hide' rather than 'override'.
      const [nearerHideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, nearerHide.id))
      assert.equal(nearerHideRow!.navigationMode, 'hide')
      assert.equal(nearerHideRow!.navigationId, null)

      const [belowHideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, belowHide.id))
      assert.equal(belowHideRow!.navigationId, belowHideSentinel)
    })

    test('(c) switching a cascading entry back to inherit hands its descendants to the next ancestor up, respecting nearer overrides beneath it', async () => {
      const rootNavId = await createNavId()
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root',
        type: 'folder',
        navigationMode: 'override',
        navigationId: rootNavId
      })
      const midNavId = await createNavId()
      // -> `mid` starts out cascading in its own right (mode 'override'); `child`/`grandchild` below
      //    it hold `midNavId` because a prior cascade from `mid` put it there.
      const mid = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid',
        type: 'folder',
        navigationMode: 'override',
        navigationId: midNavId
      })
      const child = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/child',
        type: 'folder',
        navigationId: midNavId
      })
      const grandchild = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/child/grandchild',
        navigationId: midNavId
      })
      const nearerOverrideNavId = await createNavId()
      const nearerOverride = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/nearer-override',
        type: 'folder',
        navigationMode: 'override',
        navigationId: nearerOverrideNavId
      })
      const deepUnderNearer = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-c-root/mid/nearer-override/deep',
        navigationId: nearerOverrideNavId
      })

      const { navigationMode, navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: mid.id,
        mode: 'inherit'
      })

      assert.equal(navigationMode, 'inherit')
      // -> The next ancestor up is `root`, still on 'override' — that's what `mid` and its
      //    still-inheriting descendants hand off to.
      assert.equal(navigationId, rootNavId)

      const [childRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, child.id))
      assert.equal(childRow!.navigationId, rootNavId)
      assert.equal(childRow!.navigationMode, 'inherit')

      const [grandchildRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, grandchild.id))
      assert.equal(grandchildRow!.navigationId, rootNavId)

      // -> The nearer override nested under `mid` is untouched by `mid`'s own transition (its mode
      //    isn't 'inherit')...
      const [nearerOverrideRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, nearerOverride.id))
      assert.equal(nearerOverrideRow!.navigationId, nearerOverrideNavId)
      assert.equal(nearerOverrideRow!.navigationMode, 'override')

      // -> ...and it still shields what's beneath it: `mid` handing its subtree back to `root` does
      //    not reach past the nearer override in between.
      const [deepRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, deepUnderNearer.id))
      assert.equal(deepRow!.navigationId, nearerOverrideNavId)

      // -> `root` itself is above `mid`, outside `mid`'s cascade scope entirely — untouched.
      const [rootRow] = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, root.id))
      assert.equal(rootRow!.navigationId, rootNavId)
      assert.equal(rootRow!.navigationMode, 'override')
    })

    test('(d) a sibling branch outside the target subtree is never touched (folderPath <@ fullPath::ltree scoping)', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-d-root',
        type: 'folder'
      })
      const siblingSentinel = await createNavId()
      const sibling = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-d-sibling',
        type: 'folder',
        navigationId: siblingSentinel
      })
      const siblingChildSentinel = await createNavId()
      const siblingChild = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-d-sibling/leaf',
        navigationId: siblingChildSentinel
      })

      await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      const [siblingRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, sibling.id))
      assert.equal(siblingRow!.navigationId, siblingSentinel)
      assert.equal(siblingRow!.navigationMode, 'inherit')

      const [siblingChildRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, siblingChild.id))
      assert.equal(siblingChildRow!.navigationId, siblingChildSentinel)
    })

    test('(e) tree entries of type asset are excluded from the cascade even when otherwise eligible', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-e-root',
        type: 'folder'
      })
      const branch = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-e-root/branch',
        type: 'folder'
      })
      const assetSentinel = await createNavId()
      const asset = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-e-root/branch/image',
        type: 'asset',
        navigationId: assetSentinel
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      const [branchRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, branch.id))
      assert.equal(branchRow!.navigationId, navigationId)

      const [assetRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, asset.id))
      assert.equal(assetRow!.navigationId, assetSentinel)
      assert.equal(assetRow!.navigationMode, 'inherit')
    })

    /**
     * The CTE anti-join (navigation.ts's `boundaries` CTE in `updateNavigation()`'s cascade UPDATE)
     * collects every override/hide boundary path once, up front. This is the case that would break
     * first if the de-correlation ever dropped a boundary row: a boundary directly nested under
     * another boundary, rather than the outer boundary's own non-boundary descendant that every
     * other case here exercises.
     */
    test('(f) a boundary directly nested under another boundary still shields its own subtree, and the outer boundary still shields the inner boundary itself', async () => {
      const root = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-f-root',
        type: 'folder'
      })

      const outerNavId = await createNavId()
      const outerBoundary = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-f-root/outer',
        type: 'folder',
        navigationMode: 'override',
        navigationId: outerNavId
      })

      // -> Nested directly under the outer boundary, itself a boundary (hide) rather than a plain
      //    inheriting descendant.
      const innerBoundary = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-f-root/outer/inner',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })

      const belowInnerSentinel = await createNavId()
      const belowInner = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'cascade-f-root/outer/inner/leaf',
        navigationId: belowInnerSentinel
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: root.id,
        mode: 'override'
      })

      // -> The outer boundary's own row is excluded by the `navigationMode = 'inherit'` filter, not
      //    touched by root's cascade.
      const [outerRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, outerBoundary.id))
      assert.equal(outerRow!.navigationId, outerNavId)
      assert.equal(outerRow!.navigationMode, 'override')

      // -> The inner boundary sits under the outer boundary, so the outer boundary's own
      //    "boundaryPath" shields it from root's cascade too -- it keeps its own mode/id rather
      //    than picking up root's navigationId.
      const [innerRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, innerBoundary.id))
      assert.equal(innerRow!.navigationId, null)
      assert.equal(innerRow!.navigationMode, 'hide')

      // -> Everything beneath the inner boundary is shielded by the inner boundary's own
      //    "boundaryPath" -- exactly the anti-join row the de-correlated CTE must still produce.
      const [belowInnerRow] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, belowInner.id))
      assert.equal(belowInnerRow!.navigationId, belowInnerSentinel)
      assert.equal(belowInnerRow!.navigationMode, 'inherit')

      // -> Sanity: root's cascade did reach *something* -- confirms this isn't a vacuous pass where
      //    the whole subtree got excluded for an unrelated reason.
      assert.notEqual(navigationId, null)
    })
  })

  /**
   * `items`-target routing (navigation.ts:199-218): which menu a page's saved items land in is the
   * *mode's* answer, not the entry's own id — except when that would mean nowhere at all.
   */
  describe('updateNavigation items-target routing', () => {
    const items: NavigationItem[] = [{ id: 'x', type: 'link', label: 'X', target: '/x' }]

    test('mode=inherit writes items to the resolved ancestor menu, not a menu of its own', async () => {
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'inherit-items'
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: page.id,
        mode: 'inherit',
        items
      })

      // -> Top-level page: the resolved ancestor is the site's own locale-scoped menu row, distinct
      //    from both the page's own id and the site id itself.
      assert.notEqual(navigationId, fixtures.siteId)
      assert.notEqual(navigationId, page.id)
      assert.equal(navigationId, await navigationModel.ensureSiteNav(fixtures.siteId, 'en'))
      assert.deepEqual(
        await navigationModel.getNav(fixtures.siteId, navigationId!, {
          actor: ADMIN_ACTOR,
          unfiltered: true
        }),
        items
      )

      // -> No menu was ever created under the page's own id.
      const ownRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, page.id))
      assert.equal(ownRow.length, 0)
    })

    test("a non-inherit mode (override) writes items to the entry's own menu, not the ancestor's", async () => {
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'override-items'
      })
      const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      const siteItemsBefore = await navigationModel.getNav(fixtures.siteId, siteNavId, {
        actor: ADMIN_ACTOR,
        unfiltered: true
      })

      const { navigationId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: page.id,
        mode: 'override',
        items
      })

      assert.equal(navigationId, page.id)
      assert.deepEqual(
        await navigationModel.getNav(fixtures.siteId, page.id, {
          actor: ADMIN_ACTOR,
          unfiltered: true
        }),
        items
      )
      // -> The site (ancestor) menu is untouched by a save that targeted the page's own menu.
      assert.deepEqual(
        await navigationModel.getNav(fixtures.siteId, siteNavId, {
          actor: ADMIN_ACTOR,
          unfiltered: true
        }),
        siteItemsBefore
      )
    })

    test('mode=inherit under a hidden ancestor throws navNoInheritedMenu and writes nothing', async () => {
      const hiddenFolder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hidden-parent-items',
        type: 'folder',
        navigationMode: 'hide',
        navigationId: null
      })
      const page = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'hidden-parent-items/child',
        navigationMode: 'inherit',
        navigationId: null
      })
      assert.equal(await navigationModel.inheritedNavId(fixtures.siteId, page.id), null)

      await assert.rejects(
        navigationModel.updateNavigation({
          siteId: fixtures.siteId,
          pageId: page.id,
          mode: 'inherit',
          items
        }),
        (err: any) => {
          assert.equal(err.name, 'navNoInheritedMenu')
          assert.equal(err.statusCode, 400)
          return true
        }
      )

      // -> No menu row was ever created for the page (the throw happens before that insert).
      const ownRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.id, page.id))
      assert.equal(ownRow.length, 0)

      // -> The tree update (navigationMode/navigationId, which runs after the items write) never
      //    ran either: the page is exactly as seeded.
      const [persistedPage] = await fixtures.db
        .select()
        .from(treeTable)
        .where(eq(treeTable.id, page.id))
      assert.equal(persistedPage!.navigationMode, 'inherit')
      assert.equal(persistedPage!.navigationId, null)
      void hiddenFolder
    })
  })

  /**
   * The site-root special case (navigation.ts:706-707): the home page (`folderPath === ''`,
   * `fileName === 'home'`) uses its locale's site-wide nav row (`ensureSiteNav`'s id, never `siteId`
   * itself — see #990) as its `ownNavId`, so editing its items writes to the site's own navigation
   * row rather than a page-owned one. Each case uses a brand-new site, seeded directly rather than
   * through `setupTestDb()`'s shared fixture, so the navigation row's prior state (absent vs.
   * already populated) is exactly what the case controls.
   */
  describe('updateNavigation site-root special case (home page)', () => {
    async function createSite(): Promise<string> {
      const [site] = await fixtures.db
        .insert(sitesTable)
        .values({
          hostname: `test-${randomUUID()}.localhost`,
          isEnabled: true,
          config: { locales: { primary: 'en' } }
        })
        .returning({ id: sitesTable.id })
      return site!.id
    }

    test("fresh site: saving the home page items exercises ensureSiteNav's onConflictDoNothing insert", async () => {
      const siteId = await createSite()
      // -> Nothing has ever called ensureSiteNav for this site — confirm no navigation row exists yet.
      const beforeRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.siteId, siteId))
      assert.equal(beforeRow.length, 0)

      const home = await seedTreeEntry(fixtures.db, { siteId, path: 'home' })
      const items: NavigationItem[] = [{ id: 'h', type: 'link', label: 'Home link', target: '/' }]

      const { navigationId } = await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items
      })

      // -> ownNavId resolved to the site's own (locale-scoped) nav row, not the home page's own tree
      //    entry id, and not the site id itself.
      const enSiteNavId = await navigationModel.ensureSiteNav(siteId, 'en')
      assert.equal(navigationId, enSiteNavId)
      assert.notEqual(navigationId, siteId)
      assert.notEqual(navigationId, home.id)
      assert.deepEqual(
        await navigationModel.getNav(siteId, enSiteNavId, { actor: ADMIN_ACTOR, unfiltered: true }),
        items
      )
      // -> Exactly one navigation row for this site — the insert path, not a duplicate.
      const afterRow = await fixtures.db
        .select()
        .from(navigationTable)
        .where(eq(navigationTable.siteId, siteId))
      assert.equal(afterRow.length, 1)
    })

    test('existing site nav row with prior items: saving home page items replaces rather than merges', async () => {
      const siteId = await createSite()
      const home = await seedTreeEntry(fixtures.db, { siteId, path: 'home' })
      const originalItems: NavigationItem[] = [
        { id: 'old-1', type: 'link', label: 'Old 1', target: '/old-1' },
        { id: 'old-2', type: 'link', label: 'Old 2', target: '/old-2' }
      ]
      await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items: originalItems
      })
      const enSiteNavId = await navigationModel.ensureSiteNav(siteId, 'en')
      assert.deepEqual(
        await navigationModel.getNav(siteId, enSiteNavId, { actor: ADMIN_ACTOR, unfiltered: true }),
        originalItems
      )

      const replacementItems: NavigationItem[] = [
        { id: 'new-1', type: 'link', label: 'New 1', target: '/new-1' }
      ]
      const { navigationId } = await navigationModel.updateNavigation({
        siteId,
        pageId: home.id,
        mode: 'override',
        items: replacementItems
      })

      assert.equal(navigationId, enSiteNavId)
      // -> onConflictDoUpdate's `set: { items }` replaces the array outright — the old items are
      //    gone, not merged alongside the new one.
      assert.deepEqual(
        await navigationModel.getNav(siteId, enSiteNavId, { actor: ADMIN_ACTOR, unfiltered: true }),
        replacementItems
      )
    })
  })
})

/**
 * The FK added for #1699: `tree.navigationId` references `navigation.id` with `onDelete: 'set
 * null'`. Exercised directly against the schema constraint rather than through any model method,
 * since the behaviour under test is the migration's `ON DELETE SET NULL` clause itself — deleting a
 * menu a tree row points at must null that pointer out rather than erroring (as the FK's default
 * RESTRICT would) or leaving a dangling id behind (as no constraint at all did before this change).
 */
describe('tree.navigationId FK onDelete set null (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
  })

  test('deleting the referenced navigation row nulls the pointing tree row instead of erroring', async () => {
    const [nav] = await fixtures.db
      .insert(navigationTable)
      .values({ siteId: fixtures.siteId, items: [] })
      .returning({ id: navigationTable.id })
    const entry = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: `fk-test-${randomUUID()}`,
      navigationMode: 'override',
      navigationId: nav!.id
    })

    // -> Must not throw: a RESTRICT (the FK's default with no onDelete clause) or a missing
    //    constraint entirely would either reject this delete or leave `entry` pointing at a dead id.
    await fixtures.db.delete(navigationTable).where(eq(navigationTable.id, nav!.id))

    const [after] = await fixtures.db
      .select({ navigationId: treeTable.navigationId })
      .from(treeTable)
      .where(eq(treeTable.id, entry.id))
    assert.equal(after?.navigationId, null)
  })

  test('inserting a tree row pointed at a navigationId with no matching navigation row is rejected', async () => {
    await assert.rejects(
      seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: `fk-test-dangling-${randomUUID()}`,
        navigationId: randomUUID()
      })
    )
  })
})

/**
 * OpenProject #1698: `tree.addEntry` used to resolve a new/moved page's `navigationId` by calling
 * `ensureSiteNav` directly (hardcoded at the old `addPage` call site), ignoring any overriding/hiding
 * folder above it. It now calls `ancestorNavId` -- the same ltree-ancestry walk `inheritedNavId` uses
 * -- after the folder is resolved, so a page landing under an `override`d folder picks up that
 * folder's menu immediately, not the site-wide one. `movePage` deletes and re-inserts the tree entry
 * through the same `addPage`, so it gets this for free; the second case here proves that directly
 * rather than assuming it from the shared code path.
 */
describe(
  'navigation navigationId resolves from folder ancestry in tree.addEntry (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let navigationModel: typeof import('./navigation.ts').navigation
    let pagesModel: typeof import('./pages.ts').pages
    let actor: PageActor

    before(async () => {
      fixtures = await setupTestDb()
      ;({ navigation: navigationModel } = await import('./navigation.ts'))
      ;({ pages: pagesModel } = await import('./pages.ts'))
      actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
    })

    after(async () => {
      await teardownTestDb()
    })

    test("a page created under a folder with navigationMode='override' inherits that folder's menu, not the site-wide one", async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'ancestry-create',
        type: 'folder'
      })
      const { navigationId: folderNavId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: folder.id,
        mode: 'override',
        items: [{ id: 'folder-item', type: 'link', label: 'Folder Menu', target: '/' }]
      })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'ancestry-create/child',
          title: 'Child',
          editor: 'markdown',
          content: '# Child'
        },
        actor
      )

      const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      assert.equal(page.navigationId, folderNavId)
      assert.notEqual(page.navigationId, siteNavId)
    })

    test("moving a page under a folder with navigationMode='override' resolves it to that folder's menu too", async () => {
      const folder = await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'ancestry-move',
        type: 'folder'
      })
      const { navigationId: folderNavId } = await navigationModel.updateNavigation({
        siteId: fixtures.siteId,
        pageId: folder.id,
        mode: 'override',
        items: [{ id: 'folder-item', type: 'link', label: 'Folder Menu', target: '/' }]
      })

      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'ancestry-move-source',
          title: 'Elsewhere',
          editor: 'markdown',
          content: '# Elsewhere'
        },
        actor
      )
      const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
      // -> Sanity: it starts on the site-wide menu, as a root-level page should
      assert.equal(page.navigationId, siteNavId)

      const moved = await pagesModel.movePage(
        fixtures.siteId,
        page.id,
        { path: 'ancestry-move/moved-child' },
        actor
      )

      assert.equal(moved!.navigationId, folderNavId)
    })
  }
)

/**
 * The generated-tree cache `getGeneratedTree` builds inside `getNav` (OpenProject #1825), proven
 * behaviorally rather than by counting queries: a direct, bypass-the-model mutation of a `tree` row a
 * generated menu depends on is invisible to a warm cache, and becomes visible again only once one of
 * the real write paths this feature invalidates from (or `invalidateCache` itself) runs. This is a
 * black-box proof of "no further query on a second call" — the point the query count itself would
 * otherwise be checked for — since none of `generateFromTree`'s query-builder calls round-trip through
 * `db.execute()`, which is the only spy point every other query-counting case in this file uses.
 */
describe('navigation generated-tree cache (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let treeModel: typeof import('./tree.ts').tree
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ tree: treeModel } = await import('./tree.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  async function setMode(navId: string, mode: 'static' | 'auto' | 'mixed') {
    await WIKI.db.update(navigationTable).set({ mode }).where(eq(navigationTable.id, navId))
  }

  test('a warm cache survives a direct tree mutation that bypasses every model write path, until invalidateCache runs', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await setMode(siteNavId, 'auto')
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'cache-staleness-page',
        title: 'Original Title',
        editor: 'markdown',
        content: '# Hi'
      },
      actor
    )

    const first = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.equal(first.find((item) => item.id === page.id)?.label, 'Original Title')

    // -> Bypasses every model write path this feature invalidates from -- a genuine "nothing told the
    //    cache" probe, not just a fast-follow write that happened to invalidate anyway
    await WIKI.db
      .update(treeTable)
      .set({ title: 'Mutated Behind The Cache' })
      .where(eq(treeTable.id, page.id))

    const second = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.equal(
      second.find((item) => item.id === page.id)?.label,
      'Original Title',
      'the warm cache is served, not a fresh query'
    )

    navigationModel.invalidateCache(fixtures.siteId)
    const third = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.equal(
      third.find((item) => item.id === page.id)?.label,
      'Mutated Behind The Cache',
      'invalidateCache drops the stale entry'
    )
  })

  test('createPage (tree.addPage) invalidates so a previously-cached menu picks up a page created afterwards', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await setMode(siteNavId, 'auto')
    // -> Both top-level (no parent folder), so each shows up directly in the site-root walk rather
    //    than nested under an auto-created folder -- keeps the assertion below a flat top-level check
    await pagesModel.createPage(
      fixtures.siteId,
      { path: 'addpage-invalidation-first', title: 'First', editor: 'markdown', content: '# Hi' },
      actor
    )
    const warmed = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.ok(warmed.some((item) => item.label === 'First'))

    await pagesModel.createPage(
      fixtures.siteId,
      { path: 'addpage-invalidation-second', title: 'Second', editor: 'markdown', content: '# Hi' },
      actor
    )

    const refreshed = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.ok(
      refreshed.some((item) => item.label === 'Second'),
      'createPage (tree.addPage) invalidated the warm cache'
    )
  })

  test('deletePage (tree.deleteEntry) invalidates so a previously-cached menu drops a deleted page', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await setMode(siteNavId, 'auto')
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'delete-invalidation-page', title: 'Delete Me', editor: 'markdown', content: '# Hi' },
      actor
    )
    const warmed = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.ok(warmed.some((item) => item.label === 'Delete Me'))

    await pagesModel.deletePage(fixtures.siteId, page.id, actor)

    const refreshed = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.equal(
      refreshed.some((item) => item.label === 'Delete Me'),
      false
    )
  })

  test('createFolder invalidates so a previously-cached menu picks up a new section afterwards', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await setMode(siteNavId, 'auto')
    const warmed = await navigationModel.getNav(fixtures.siteId, siteNavId, { actor: ADMIN_ACTOR })
    assert.equal(
      warmed.some((item) => item.label === 'Fresh Folder'),
      false
    )

    await treeModel.createFolder({
      parentPath: '',
      pathName: 'fresh-folder',
      title: 'Fresh Folder',
      locale: 'en',
      siteId: fixtures.siteId
    })
    // -> An empty folder holds no visible page, so it would not appear anyway -- give it one so the
    //    walk's `holdsVisiblePages` EXISTS actually includes it, isolating what this test means to prove
    await pagesModel.createPage(
      fixtures.siteId,
      { path: 'fresh-folder/inside', title: 'Inside', editor: 'markdown', content: '# Hi' },
      actor
    )

    const refreshed = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.ok(refreshed.some((item) => item.label === 'Fresh Folder'))
  })

  test('updatePage publishState/icon changes invalidate a menu depending on them', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await setMode(siteNavId, 'auto')
    const draft = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'publish-invalidation-page',
        title: 'Publish Me',
        editor: 'markdown',
        content: '# Hi',
        publishState: 'draft'
      },
      actor
    )

    const beforePublish = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.equal(
      beforePublish.some((item) => item.label === 'Publish Me'),
      false
    )

    await pagesModel.updatePage(fixtures.siteId, draft.id, { publishState: 'published' }, actor)

    const afterPublish = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.ok(afterPublish.some((item) => item.label === 'Publish Me'))

    await pagesModel.updatePage(fixtures.siteId, draft.id, { icon: 'mdi:star' }, actor)

    const afterIcon = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.equal(afterIcon.find((item) => item.label === 'Publish Me')?.icon, 'mdi:star')
  })

  test('updateNavigation mode changes invalidate a previously-cached ancestor menu', async () => {
    const folder = await treeModel.createFolder({
      parentPath: '',
      pathName: 'cascade-cache-section',
      title: 'Cascade Cache Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'cascade-cache-section/inside',
        title: 'Inside Section',
        editor: 'markdown',
        content: '# Hi'
      },
      actor
    )
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await setMode(siteNavId, 'auto')

    // -> The folder itself is the top-level generated item here ('Inside Section' is nested a level
    //    below it) -- and it is exactly what a `hide` on the folder drops outright, so asserting on
    //    the folder's own presence is both the simpler check and the one `generateFromTree`'s
    //    hide-boundary rule (dropped, not just emptied) actually promises
    const beforeHide = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.ok(beforeHide.some((item) => item.label === 'Cascade Cache Section'))

    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: folder.id,
      mode: 'hide'
    })

    const afterHide = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR
    })
    assert.equal(
      afterHide.some((item) => item.label === 'Cascade Cache Section'),
      false
    )
  })

  test('a warm generated-tree cache never leaks a visibilityGroups-restricted stored item between actors on a mixed menu', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'mixed-actor-safety-page',
        title: 'Mixed Actor Page',
        editor: 'markdown',
        content: '# Hi'
      },
      actor
    )
    await navigationModel.setNavItems(fixtures.siteId, siteNavId, [
      {
        id: 'restricted-item',
        type: 'link',
        label: 'Restricted',
        target: '/secret',
        visibilityGroups: ['editors']
      }
    ])
    await setMode(siteNavId, 'mixed')

    // -> Warms the shared generated-tree cache from a call that also carries the restricting group,
    //    so the generated portion is genuinely cached before the group-blind assertion below runs
    const withGroup = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR,
      userGroups: ['editors']
    })
    assert.ok(withGroup.some((item) => item.id === 'restricted-item'))
    assert.ok(withGroup.some((item) => item.label === 'Mixed Actor Page'))

    const withoutGroup = await navigationModel.getNav(fixtures.siteId, siteNavId, {
      actor: ADMIN_ACTOR,
      userGroups: []
    })
    assert.equal(
      withoutGroup.some((item) => item.id === 'restricted-item'),
      false
    )
    // -> The shared, cached generated portion is untouched by the other actor's missing group
    assert.ok(withoutGroup.some((item) => item.label === 'Mixed Actor Page'))
  })
})

/**
 * The content lifecycle log line (OpenProject #2674): one `info nav updated` record per menu
 * rewrite, from either editor — the admin menu editor (`setNavItems`) and the page-context one
 * (`updateNavigation`).
 *
 * Asserted on the SCOPE and the FIELDS a call passed, never on a rendered string — the renderer is
 * `core/logger.ts`'s business, and a suite matching formatted text breaks the moment a column widens.
 */
describe('navigation lifecycle log lines (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let navigationModel: typeof import('./navigation.ts').navigation
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor
  let originalInfo: any
  let infoCalls: { scope: string; message: string; fields: Record<string, any> }[]

  before(async () => {
    fixtures = await setupTestDb()
    ;({ navigation: navigationModel } = await import('./navigation.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  beforeEach(() => {
    infoCalls = []
    originalInfo = WIKI.logger.info
    WIKI.logger.info = ((scope: string, message: string, fields: Record<string, any> = {}) => {
      infoCalls.push({ scope, message, fields })
    }) as any
  })

  afterEach(() => {
    WIKI.logger.info = originalInfo
  })

  function navLines() {
    return infoCalls.filter((call) => call.scope === 'nav')
  }

  test('setNavItems on a site-wide default logs the locale that row carries and the item count', async () => {
    const siteNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'en')
    infoCalls = []

    await navigationModel.setNavItems(
      fixtures.siteId,
      siteNavId,
      [
        { id: 'a', type: 'link', label: 'Home', target: '/' },
        { id: 'b', type: 'link', label: 'Docs', target: '/docs' }
      ],
      { authorId: fixtures.userId }
    )

    const lines = navLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.message, 'updated')
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      nav: siteNavId,
      locale: 'en',
      items: 2,
      user: fixtures.userId
    })
  })

  test("setNavItems on a tree entry's own override carries no locale, since that row has none", async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'nav-log-override', title: 'Nav Log', editor: 'markdown', content: '# Hi' },
      actor
    )
    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override'
    })
    infoCalls = []

    await navigationModel.setNavItems(fixtures.siteId, page.id, [
      { id: 'c', type: 'header', label: 'Section' }
    ])

    const lines = navLines()
    assert.equal(lines.length, 1)
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      nav: page.id,
      items: 1,
      user: 'system'
    })
  })

  test('a refused setNavItems logs nothing', async () => {
    await assert.rejects(
      () => navigationModel.setNavItems(fixtures.siteId, randomUUID(), []),
      /does not exist/
    )

    assert.deepEqual(navLines(), [])
  })

  test('updateNavigation logs the page it was edited from, its locale and the mode', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'nav-log-page', title: 'Nav Log Page', editor: 'markdown', content: '# Hi' },
      actor
    )
    infoCalls = []

    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'override',
      items: [{ id: 'd', type: 'link', label: 'One', target: '/one' }],
      authorId: fixtures.userId
    })

    const lines = navLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.message, 'updated')
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      nav: page.id,
      locale: 'en',
      page: page.id,
      mode: 'override',
      items: 1,
      user: fixtures.userId
    })
  })

  test('copyNav logs the same line, naming the menu the items came from', async () => {
    const sourceNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'de')
    const targetNavId = await navigationModel.ensureSiteNav(fixtures.siteId, 'es')
    await navigationModel.setNavItems(fixtures.siteId, sourceNavId, [
      { id: 'e', type: 'link', label: 'Copied', target: '/copied' }
    ])
    infoCalls = []

    await navigationModel.copyNav({
      sourceSiteId: fixtures.siteId,
      sourceId: sourceNavId,
      targetSiteId: fixtures.siteId,
      targetId: targetNavId,
      mode: 'replace',
      authorId: fixtures.userId
    })

    const lines = navLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.message, 'updated')
    assert.deepEqual(lines[0]!.fields, {
      site: fixtures.siteId,
      nav: targetNavId,
      from: sourceNavId,
      items: 1,
      copy: 'replace',
      user: fixtures.userId
    })
  })

  test('a bare mode switch writes no items, so the line carries no item count', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'nav-log-mode-only', title: 'Mode Only', editor: 'markdown', content: '# Hi' },
      actor
    )
    infoCalls = []

    await navigationModel.updateNavigation({
      siteId: fixtures.siteId,
      pageId: page.id,
      mode: 'hide',
      authorId: fixtures.userId
    })

    const fields = navLines()[0]!.fields
    assert.equal('items' in fields, false)
    assert.equal('nav' in fields, false, 'a hidden sidebar resolves to no menu row at all')
    assert.equal(fields.mode, 'hide')
    assert.equal(fields.page, page.id)
  })
})
