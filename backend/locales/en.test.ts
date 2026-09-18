import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Trimmed by OpenProject #2690 (`docs/testing-audit/backend.md`'s `locales/en.test.ts` row): the
 * duplicate-key and alphabetical-sort checks that used to open this describe were pure data-file
 * linting with nothing uniquely gated by either — a formatter-shaped check, not a product one. What
 * remains is the removal-guard coverage the audit names as the one thing nothing else protects:
 * dead locale key clusters silently reappearing.
 */
describe('backend/locales/en.json', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  /**
   * Regression coverage for the dead GraphQL-era developer-tools locale keys (OpenProject #1634 /
   * #1984 / #2014). `admin.dev.title`, `admin.dev.graphiql.title` and `admin.dev.voyager.title`
   * described an admin "Developer Tools" page with GraphiQL/Voyager panels that no longer exists;
   * `admin.utilities.graphEndpointSubtitle`/`admin.utilities.graphEndpointTitle` described the
   * now-removed GraphQL endpoint setting alongside it — GraphQL was removed from the live surface
   * and `grep -rni 'graphiql|voyager|graphendpoint'`
   * across `backend/`, `frontend/src` and `blocks/` returns nothing but these locale declarations.
   * `admin.logging.title` described a Logging admin page with no surviving route or component.
   * `admin.dev.flags.title` is deliberately excluded from this list — a real Flags admin page exists
   * at `/_admin/flags` (`frontend/src/layouts/AdminLayout.vue`) and reads it.
   */
  test('has no orphaned admin.dev.* GraphQL-tooling, admin.utilities.graphEndpoint*, or admin.logging.* keys', async () => {
    const raw = await readFile(localePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>

    for (const deadKey of [
      'admin.dev.title',
      'admin.dev.graphiql.title',
      'admin.dev.voyager.title',
      'admin.logging.title',
      'admin.utilities.graphEndpointSubtitle',
      'admin.utilities.graphEndpointTitle'
    ]) {
      assert.equal(
        Object.hasOwn(parsed, deadKey),
        false,
        `${deadKey} is dead (no reader anywhere in the repo) and must not reappear in en.json`
      )
    }

    // -> The live Flags admin page's nav label -- must survive this and any future dead-key sweep.
    assert.equal(Object.hasOwn(parsed, 'admin.dev.flags.title'), true)
  })
})

/**
 * Regression guard for OpenProject WP #1634: `backend/locales/en.json` used to ship strings for
 * surfaces this branch has already removed — the Wiki.js 1.x importer and the route-unreachable
 * `admin.tags.*` cluster backing `frontend/src/pages/AdminTags.vue`. Every one of those keys had
 * zero references across `frontend/src`, `backend/api`, `backend/models`, `backend/controllers` and
 * `e2e` (verified by grep, not by a generic unused-key scan — several other namespaces are addressed
 * by runtime key construction and are deliberately out of this WP's scope). This test locks the
 * deletion in place so none of the dead clusters silently reappears. The GraphQL dev-tool/endpoint
 * cluster this WP originally also covered is folded into the describe above, whose dead-key list
 * already includes it (see that test's docblock).
 */
describe('backend/locales/en.json — dead key clusters stay removed', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  async function loadParsed() {
    const raw = await readFile(localePath, 'utf8')
    return JSON.parse(raw) as Record<string, string>
  }

  test('no Wiki.js 1.x importer keys', async () => {
    const parsed = await loadParsed()
    for (const deadKey of ['admin.utilities.importv1Subtitle', 'admin.utilities.importv1Title']) {
      assert.equal(Object.hasOwn(parsed, deadKey), false, `${deadKey} should have been deleted`)
    }
  })

  test('no admin.tags.* keys (AdminTags.vue is route-unreachable)', async () => {
    const parsed = await loadParsed()
    const tagsKeys = Object.keys(parsed).filter((k) => k.startsWith('admin.tags.'))
    assert.deepEqual(tagsKeys, [])
  })

  test('surviving admin.dev.* and admin.utilities.* namespaces are untouched', async () => {
    const parsed = await loadParsed()
    // -> `admin.dev.title` (the "Developer Tools" section wrapping just `flags`) was itself swept as
    //    unreferenced by the later, more thorough #2014 pass -- AdminLayout.vue's nav flattened to a
    //    standalone "Flags" item with no wrapping section header once GraphiQL/Voyager, its only other
    //    children, were gone. `admin.dev.flags.title` is the one key from this prefix #2014 confirmed
    //    still has a reader (the nav label for /_admin/flags) and kept.
    assert.equal(Object.hasOwn(parsed, 'admin.dev.flags.title'), true)
    assert.equal(Object.hasOwn(parsed, 'admin.utilities.import'), true)
    assert.equal(Object.hasOwn(parsed, 'admin.utilities.invalidApiCertificates'), true)
  })

  /**
   * OpenProject #3287: `mail.eventSubscription.*` backed `MailModel#sendEventSubscriptionNotification`,
   * and the per-event `mail.notificationEvent.<event>.label`/`bodyPlain.*`/`bodyWithTarget.*`/
   * `subjectPlain`/`subjectWithTarget`/`templateFooter`/`unknownActor` keys backed
   * `MailModel#sendNotificationEvent` -- both removed as dead code (the `eventSubscriptions` table had
   * no writer, and `sendNotificationEvent` had no caller at all). `mail.notificationEvent.{subject,
   * text,html,footer}` and every `mail.notificationEventLabel.*` key back the still-live
   * `sendEventNotification` path and must survive this and any future dead-key sweep.
   */
  test('no mail.eventSubscription.* or sendNotificationEvent-only mail.notificationEvent.* keys', async () => {
    const parsed = await loadParsed()
    const eventSubscriptionKeys = Object.keys(parsed).filter((k) =>
      k.startsWith('mail.eventSubscription.')
    )
    assert.deepEqual(eventSubscriptionKeys, [])

    for (const deadKey of [
      'mail.notificationEvent.subjectPlain',
      'mail.notificationEvent.subjectWithTarget',
      'mail.notificationEvent.templateFooter',
      'mail.notificationEvent.unknownActor',
      'mail.notificationEvent.bodyPlain.text',
      'mail.notificationEvent.bodyPlain.html',
      'mail.notificationEvent.bodyWithTarget.text',
      'mail.notificationEvent.bodyWithTarget.html',
      'mail.notificationEvent.page:create.label',
      'mail.notificationEvent.user:join.label'
    ]) {
      assert.equal(Object.hasOwn(parsed, deadKey), false, `${deadKey} should have been deleted`)
    }

    // -> The surviving sendEventNotification path's own keys must not be caught by the same sweep.
    for (const liveKey of [
      'mail.notificationEvent.subject',
      'mail.notificationEvent.text',
      'mail.notificationEvent.html',
      'mail.notificationEvent.footer',
      'mail.notificationEventLabel.page:create',
      'mail.notificationEventLabel.user:join'
    ]) {
      assert.equal(Object.hasOwn(parsed, liveKey), true, `${liveKey} must still exist`)
    }
  })
})

/**
 * Regression guard for OpenProject WP #2620: `common.footerPoweredBy` shipped as the lowercase
 * `"powered by {link}"` while its sibling `common.footerGeneric` — the same credit, rendered by the
 * same `FooterNav.vue` on the generic branch — already read `"Powered by {link}, an open source
 * project."`. The two therefore drew the footer credit two different ways depending on which
 * keypath the component picked, which is what the WP corrects.
 *
 * This lives here rather than in `frontend/`'s own suites deliberately. `FooterNav.test.js` and
 * `AuthLayout.test.js` each build their i18n fixture by hand and both hardcode the *capitalised*
 * form, so neither one reads `en.json` at all — reverting the source string leaves the whole
 * frontend suite green. This file is the only place the actual shipped string is asserted.
 */
describe('backend/locales/en.json — footer credit casing', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  test('both footer credit strings open with a capitalised "Powered by"', async () => {
    const raw = await readFile(localePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>

    for (const key of ['common.footerPoweredBy', 'common.footerGeneric']) {
      const value = parsed[key]
      assert.equal(typeof value, 'string', `${key} must exist in en.json`)
      assert.ok(
        value.startsWith('Powered by '),
        `${key} must open with the capitalised "Powered by " -- the two footer credit strings are ` +
          `rendered by the same component and must not disagree on casing (got: ${JSON.stringify(value)})`
      )
    }
  })
})

/**
 * Regression guard for WP #2653 (rebrand: user-facing strings and locales). `en.json` is the
 * Localazy source every other locale file re-syncs from, so a product name typed once here ends up
 * in 56 files; its 17 `Wiki.js` occurrences were rewritten to `Cardinal.js`.
 *
 * Deliberately scoped to this one file rather than being the repo-wide grep Feature #2617 argues
 * against. That argument is about the exclusion list: a whole-repo gate would have to encode every
 * legitimate upstream reference (`backend/migration/`, the AGPL notices, the opencollective and
 * requarks/wiki links, the importer dialogs' "Wiki.js's own Markdown" copy) and would fail the day
 * a new one is written. Here the exclusion list is one named constant covering the only category of
 * English string that could legitimately name upstream -- copy about importing from a real Wiki.js
 * 2.5.x instance -- and adding to it is one line with the reason beside it.
 */
describe('backend/locales/en.json -- product name', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  /**
   * Keys whose English text is ALLOWED to name Wiki.js, because it means the real upstream product
   * rather than this fork -- the same test Feature #2617 sets for the sweep as a whole: does the
   * sentence remain true after the rename?
   *
   * Empty today. A string about the 2.5.x importer ("Import from a Wiki.js 2.5.x database...") is
   * the expected first entry; add the key here with its reason rather than loosening the assertion.
   */
  const upstreamReferenceKeys: readonly string[] = []

  async function loadParsed() {
    const raw = await readFile(localePath, 'utf8')
    return JSON.parse(raw) as Record<string, string>
  }

  test('names this product Cardinal.js, never upstream Wiki.js', async () => {
    const parsed = await loadParsed()
    const offenders = Object.entries(parsed)
      .filter(([key, value]) => !upstreamReferenceKeys.includes(key) && /wiki\.?js/i.test(value))
      .map(([key]) => key)

    assert.deepEqual(
      offenders,
      [],
      'these en.json strings still name Wiki.js -- rename them to Cardinal.js, or, if one genuinely ' +
        `describes upstream Wiki.js, add its key to upstreamReferenceKeys: ${offenders.join(', ')}`
    )
  })

  test('still carries the renamed strings, so the check above cannot pass vacuously', async () => {
    const parsed = await loadParsed()
    // -> Deleting the keys rather than rewriting them would also satisfy the assertion above while
    //    removing the copy entirely. Two of the seventeen, one from each end of the file.
    assert.equal(parsed['admin.dashboard.wikiVersion'], 'Cardinal.js version')
    assert.equal(parsed['welcome.title'], 'Welcome to Cardinal.js!')
  })
})

/**
 * Regression guard for OpenProject #3412: CLAUDE.md's Permissions section documents `read:source`
 * as the one exception to "names are not interchangeable" -- `write:pages` and `manage:pages` each
 * imply it (`helpers/pageAccess.ts#mayReadSource`, OpenProject #3391/#3411). The rule editor's hint
 * is where an administrator granting the rule learns that, since `GroupRulesEditor.vue` renders this
 * string verbatim as the `read:source` option's caption -- so the hint text is what actually carries
 * the documented exception to the UI, not just to this file.
 */
describe('backend/locales/en.json -- read:source implicitly-held-by hint (OpenProject #3412)', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  test('read:source hint names both permissions that imply it', async () => {
    const raw = await readFile(localePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>

    const hint = parsed['admin.groups.permissions.read:source.hint']
    assert.equal(typeof hint, 'string', 'admin.groups.permissions.read:source.hint must exist')
    assert.ok(
      hint.includes('write:pages') && hint.includes('manage:pages'),
      `read:source hint must name both write:pages and manage:pages as implicitly holding it ` +
        `(got: ${JSON.stringify(hint)})`
    )
  })
})
