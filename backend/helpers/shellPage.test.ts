import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { installTestWiki } from '../test/mocks.ts'
import { makeGroupRule } from '../test/builders.ts'
import type { GroupRule } from '../models/groups.ts'
import { lookupShellPage } from './shellPage.ts'

const SITE_ID = 'site-1'
const GUESTS = 'guests-group'

interface Row {
  locale: string
  path: string
  title: string
  description: string | null
  tags: string[]
  classification: string | null
  password: string | null
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    locale: 'en',
    path: 'docs/guide',
    title: 'Guide',
    description: 'How to',
    tags: [],
    classification: null,
    password: null,
    ...overrides
  }
}

describe('lookupShellPage', () => {
  let wiki: { restore(): void }
  let selects: Array<Record<string, unknown>>
  let rowsToReturn: Row[]
  let guestRules: GroupRule[]

  function install(
    locales: Record<string, unknown> | undefined = { primary: 'en', active: ['en'] }
  ) {
    selects = []
    const chain: any = {
      from: () => chain,
      where: () => Promise.resolve(rowsToReturn)
    }
    wiki = installTestWiki({
      db: {
        select: (selection: Record<string, unknown>) => {
          selects.push(selection)
          return chain
        }
      },
      data: { systemIds: { guestsGroupId: GUESTS } },
      sites: { [SITE_ID]: { config: { locales } } },
      models: {
        groups: {
          rulesForGroups: mock.fn((ids: string[]) => {
            assert.deepEqual(ids, [GUESTS])
            return guestRules
          })
        }
      }
    })
  }

  beforeEach(() => {
    rowsToReturn = []
    guestRules = [makeGroupRule({ match: 'START', path: '' })]
    install()
  })

  afterEach(() => wiki.restore())

  test('a guest-readable published page returns its metadata', async () => {
    rowsToReturn = [row()]
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/docs/guide', locale: 'en' })
    assert.deepEqual(result, {
      title: 'Guide',
      description: 'How to',
      path: 'docs/guide',
      locale: 'en',
      translations: [{ locale: 'en', path: 'docs/guide' }]
    })
  })

  test('a missing page returns null', async () => {
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/nope', locale: 'en' })
    assert.equal(result, null)
  })

  test('a page the guests group cannot read returns null', async () => {
    rowsToReturn = [row({ path: 'hr/salaries' })]
    guestRules = [
      makeGroupRule({ match: 'START', path: '' }),
      makeGroupRule({ id: 'deny', match: 'START', path: 'hr', mode: 'DENY' })
    ]
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/hr/salaries', locale: 'en' })
    assert.equal(result, null)
  })

  test('with no guest rule at all, nothing is readable', async () => {
    rowsToReturn = [row()]
    guestRules = []
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/docs/guide', locale: 'en' })
    assert.equal(result, null)
  })

  test('a password-locked page returns null, the same as a missing one', async () => {
    rowsToReturn = [row({ password: '$2a$hash' })]
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/docs/guide', locale: 'en' })
    assert.equal(result, null)
  })

  test('a private page and a nonexistent path return the identical value', async () => {
    rowsToReturn = [row({ password: '$2a$hash' })]
    const locked = await lookupShellPage({ siteId: SITE_ID, urlPath: '/docs/guide', locale: 'en' })
    rowsToReturn = []
    const missing = await lookupShellPage({ siteId: SITE_ID, urlPath: '/docs/guide', locale: 'en' })
    assert.strictEqual(locked, missing)
  })

  test('a page rule keyed on tags is judged against the row tags', async () => {
    rowsToReturn = [row({ tags: ['internal'] })]
    guestRules = [
      makeGroupRule({ match: 'START', path: '' }),
      makeGroupRule({ id: 'tag-deny', match: 'TAG', mode: 'DENY', tags: ['internal'] })
    ]
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/docs/guide', locale: 'en' })
    assert.equal(result, null)
  })

  test('issues exactly one query and selects no body columns', async () => {
    rowsToReturn = [row()]
    await lookupShellPage({ siteId: SITE_ID, urlPath: '/docs/guide', locale: 'en' })
    assert.equal(selects.length, 1)
    const keys = Object.keys(selects[0]!)
    for (const excluded of ['render', 'content', 'searchContent', 'ts', 'toc', 'links']) {
      assert.ok(!keys.includes(excluded), `selection should omit ${excluded}`)
    }
  })

  test('a path outside the page-path alphabet returns null without querying', async () => {
    for (const urlPath of ['/a b.c', '/a%00b', '/%E0%A4%A', '/a?b', '/docs/<x>']) {
      assert.equal(await lookupShellPage({ siteId: SITE_ID, urlPath, locale: 'en' }), null, urlPath)
    }
    assert.equal(selects.length, 0)
  })

  test('the root path resolves to the home page', async () => {
    rowsToReturn = [row({ path: 'home', title: 'Home' })]
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/', locale: 'en' })
    assert.equal(result?.path, 'home')
  })

  test('a trailing slash and upper case address the same page', async () => {
    rowsToReturn = [row()]
    const result = await lookupShellPage({ siteId: SITE_ID, urlPath: '/Docs/Guide/', locale: 'en' })
    assert.equal(result?.path, 'docs/guide')
  })

  describe('with several locales', () => {
    beforeEach(() => {
      wiki.restore()
      install({ primary: 'en', active: ['en', 'fr', 'de'] })
    })

    test('a locale prefix is stripped before the path is looked up', async () => {
      rowsToReturn = [row({ locale: 'fr', title: 'Guide FR' })]
      const result = await lookupShellPage({
        siteId: SITE_ID,
        urlPath: '/fr/docs/guide',
        locale: 'fr'
      })
      assert.equal(result?.title, 'Guide FR')
      assert.equal(result?.path, 'docs/guide')
      assert.equal(result?.locale, 'fr')
    })

    test('the page in the requested locale is returned, its siblings become translations', async () => {
      rowsToReturn = [
        row({ locale: 'fr', title: 'Guide FR' }),
        row({ locale: 'en', title: 'Guide' }),
        row({ locale: 'de', title: 'Anleitung' })
      ]
      const result = await lookupShellPage({
        siteId: SITE_ID,
        urlPath: '/docs/guide',
        locale: 'en'
      })
      assert.equal(result?.title, 'Guide')
      assert.deepEqual(result?.translations, [
        { locale: 'de', path: 'docs/guide' },
        { locale: 'en', path: 'docs/guide' },
        { locale: 'fr', path: 'docs/guide' }
      ])
    })

    test('a locked or unreadable translation is left out of the translations', async () => {
      rowsToReturn = [
        row({ locale: 'en' }),
        row({ locale: 'fr', password: '$2a$hash' }),
        row({ locale: 'de', classification: 'secret' })
      ]
      guestRules = [
        makeGroupRule({ match: 'START', path: '' }),
        makeGroupRule({
          id: 'deny-secret',
          match: 'CLASSIFICATION',
          mode: 'DENY',
          classifications: ['secret']
        })
      ]
      const result = await lookupShellPage({
        siteId: SITE_ID,
        urlPath: '/docs/guide',
        locale: 'en'
      })
      assert.deepEqual(result?.translations, [{ locale: 'en', path: 'docs/guide' }])
    })

    test('a page that exists only in another locale returns null for the requested one', async () => {
      rowsToReturn = [row({ locale: 'fr' })]
      const result = await lookupShellPage({
        siteId: SITE_ID,
        urlPath: '/docs/guide',
        locale: 'en'
      })
      assert.equal(result, null)
    })
  })
})
