import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

describe('backend/locales/en.json', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

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

    // -> The live Flags admin page's nav label: a dead-key sweep must not take it.
    assert.equal(Object.hasOwn(parsed, 'admin.dev.flags.title'), true)
  })
})

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
    assert.equal(Object.hasOwn(parsed, 'admin.dev.flags.title'), true)
    assert.equal(Object.hasOwn(parsed, 'admin.utilities.import'), true)
    assert.equal(Object.hasOwn(parsed, 'admin.utilities.invalidApiCertificates'), true)
  })

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

    // -> The live `sendEventNotification` path's keys must not be caught by the same sweep.
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
 * Lives here rather than in `frontend/`: `FooterNav.test.js` builds its i18n fixture by hand and
 * never reads `en.json`, so nothing else asserts the shipped strings.
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
 * Scoped to this one file rather than a repo-wide grep: a whole-repo gate would have to encode every
 * legitimate upstream reference and would fail the day a new one is written.
 */
describe('backend/locales/en.json -- product name', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  /**
   * Keys whose English text may name Wiki.js because it means the real upstream product (copy about
   * the 2.5.x importer, say). Add a key here with its reason rather than loosening the assertion.
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
    assert.equal(parsed['admin.dashboard.wikiVersion'], 'Cardinal.js version')
    assert.equal(parsed['welcome.title'], 'Welcome to Cardinal.js!')
  })
})

/**
 * `GroupRulesEditor.vue` renders this string verbatim as the `read:source` option's caption: it is
 * where an administrator learns that `write:pages` and `manage:pages` imply it
 * (`helpers/pageAccess.ts#mayReadSource`).
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
