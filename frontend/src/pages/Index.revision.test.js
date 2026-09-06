import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import Index from './Index.vue'
import { usePageStore } from '@/stores/page'
import { useUserStore } from '@/stores/user'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * OpenProject #2652 -- the Revision section in the page metadata rail, the consumer half of Feature
 * #2607 (its producer half, #2651, puts `revision: { ordinal, changeCount }` on the page read).
 * #2735 adds `revision.via` and the "via MCP" badge next to the author name, reusing the history
 * timeline's own badge and locale keys (`PageHistoryOverlay.vue`).
 *
 * The section has three renderings and the difference between them is ABSENCE, never a zero, so
 * that is what these assert:
 *
 *   1. full       -- `rev 14 · 6 changes`, the author, the relative time
 *   2. no history -- `rev 1` alone: no interpunct and no `0 changes` clause after it
 *   3. no history PERMISSION -- the author and the time alone: `revision` is missing from the
 *      payload entirely, and the rev line goes with it while the section stays
 *
 * Driven through the real page read rather than by writing `pageStore.revision` directly: the
 * payload's shape IS the contract under test here (a missing key and a present-but-partial object
 * mean two different things), and a test that patched the store by hand would prove the template
 * reads a field without proving the store keeps that field honest.
 */

/** A page as the read route returns one, with only what `Index.vue` and `pagePatch` actually read. */
function pagePayload(overrides = {}) {
  return {
    id: 'page-1',
    path: 'runbooks/deploys',
    locale: 'en',
    title: 'Deploys',
    description: '',
    icon: 'tabler:file-text',
    render: '<p>Some text.</p>',
    toc: [],
    tags: [],
    relations: [],
    tocDepth: { min: 1, max: 6 },
    authorId: 'user-1',
    authorName: 'Dylan Hart',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-09-01T16:12:00.000Z',
    viewer: { permissions: ['read:pages'] },
    ...overrides
  }
}

/*
  Real English for the keys these tests read the rendered text of; every other `t()` call in this
  view renders as its bare key, which none of them look at. The plural form is the one from
  `backend/locales/en.json`, pipes and all -- `revisionChanges` is passed a count, so a single-form
  message here would not exercise the same resolution path the app takes.
*/
const MESSAGES = {
  'common.page.revision': 'Revision',
  'common.page.revisionOrdinal': 'rev {ordinal}',
  'common.page.revisionChanges': '1 change | {count} changes',
  'common.page.revisionLine': '{revision} · {changes}',
  'common.page.contents': 'Contents',
  'common.page.tags': 'Tags',
  'history.viaMcp': 'via MCP',
  'history.viaMcpHint':
    'This version was written by an MCP tool call acting as this author, not typed into the editor directly.'
}

const STUBS = {
  PageHeader: true,
  PageActionsCol: true,
  PageToc: true,
  PageTags: true,
  SideDialog: true,
  PageRedirect: true,
  FooterNav: true,
  PageComments: true
}

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

function mountIndex() {
  const mounted = mountWithApp(Index, {
    messages: MESSAGES,
    routes: ['/'],
    stores: { site: { id: 'site-1' } },
    global: { stubs: STUBS }
  })
  activeWrapper = mounted.wrapper
  return mounted
}

/** Mounts the view on a loaded page, and hands back the rail's Revision section. */
async function mountWithPage(payload) {
  stubApi(new Map([[/^sites\/.*\/pages\//, payload]]))

  const mounted = mountIndex()
  // -> Twice: the block-loading scan the route watcher queues runs a tick behind `pageLoad`
  await flushPromises()
  await flushPromises()

  return {
    ...mounted,
    heading: mounted.wrapper
      .findAll('.page-sidebar-heading')
      .find((el) => el.text() === 'Revision'),
    section: mounted.wrapper.find('.page-sidebar-revision')
  }
}

describe('Index.vue: the rail’s Revision section (#2652)', () => {
  it('draws the ordinal and the change count on a page whose history this reader may see', async () => {
    const { heading, section } = await mountWithPage(
      pagePayload({ revision: { ordinal: 14, changeCount: 6 } })
    )

    expect(heading?.exists()).toBe(true)
    expect(section.text()).toContain('rev 14 · 6 changes')
    expect(section.text()).toContain('Dylan Hart')
  })

  it('says "1 change" rather than "1 changes" for a single changed line', async () => {
    const { section } = await mountWithPage(
      pagePayload({ revision: { ordinal: 2, changeCount: 1 } })
    )

    expect(section.text()).toContain('rev 2 · 1 change')
    expect(section.text()).not.toContain('1 changes')
  })

  it('renders `rev 1` alone on a page with nothing to diff against, not `· 0 changes`', async () => {
    const { section } = await mountWithPage(pagePayload({ revision: { ordinal: 1 } }))

    expect(section.text()).toContain('rev 1')
    expect(section.text()).not.toContain('·')
    expect(section.text()).not.toContain('change')
    expect(section.text()).toContain('Dylan Hart')
  })

  it('treats a zero change count as nothing to diff against rather than as a count of zero', async () => {
    // -> The server never sends a zero (absence is how it says "nothing to compare against"), so
    //    this is the defensive half of the same rule: a zero that somehow arrives must not draw a
    //    clause claiming zero lines changed.
    const { section } = await mountWithPage(
      pagePayload({ revision: { ordinal: 3, changeCount: 0 } })
    )

    expect(section.text()).toContain('rev 3')
    expect(section.text()).not.toContain('0 change')
  })

  it('omits the rev line, but keeps the section, for a reader without `read:history`', async () => {
    // -> No `revision` key at all: that IS the permission answer, and it is the only difference
    //    between this payload and the first test's.
    const { heading, section } = await mountWithPage(pagePayload())

    expect(heading?.exists()).toBe(true)
    expect(section.text()).not.toContain('rev')
    expect(section.text()).toContain('Dylan Hart')
  })

  it('formats the timestamp through `userStore.formatRecent`, not as a date of its own', async () => {
    // -> Inside the last week, which is the branch `formatRecent` exists for: a weekday and a time
    //    rather than the full date `formatDateTime` would give.
    const updatedAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    const { section, i18n } = await mountWithPage(
      pagePayload({ updatedAt, revision: { ordinal: 4, changeCount: 2 } })
    )

    const expected = useUserStore().formatRecent(i18n.global.t, updatedAt)
    expect(expected).not.toBe('')
    expect(section.text()).toContain(expected)
    // -> And not the raw stored value, which is what a template interpolating `updatedAt` would show
    expect(section.text()).not.toContain(updatedAt)
  })

  it('draws no empty section before a page has landed in the store', async () => {
    // -> Every real page has an author and a last-saved moment, so this is the loading state, not a
    //    page: a heading over three blank lines is what the guard prevents.
    const { heading, section } = await mountWithPage(pagePayload({ authorName: '', updatedAt: '' }))

    expect(heading).toBe(undefined)
    expect(section.exists()).toBe(false)
  })
})

/**
 * The store half: `revision` is stated explicitly by `pageLoad` rather than left to `pagePatch`'s
 * spread of the response, because the key is ABSENT for a reader without `read:history` -- and a
 * spread of a payload that does not carry it would leave the previous page's ordinal standing.
 */
describe('pageStore.revision across loads (#2652)', () => {
  it('keeps what the page read sent', async () => {
    const { pageStore } = await mountWithPage(pagePayload({ revision: { ordinal: 9 } }))

    expect(pageStore.revision).toEqual({ ordinal: 9 })
  })

  it('drops it when the next page answers without one', async () => {
    const { pageStore } = await mountWithPage(pagePayload({ revision: { ordinal: 9 } }))
    expect(pageStore.revision).toEqual({ ordinal: 9 })

    stubApi(new Map([[/^sites\/.*\/pages\//, pagePayload()]]))
    await pageStore.pageLoad({ path: 'somewhere/else' })

    expect(pageStore.revision).toBe(null)
  })

  it('is blanked for a path with no page at all', async () => {
    const { pageStore } = await mountWithPage(pagePayload({ revision: { ordinal: 9 } }))

    pageStore.pageNotFound({ path: 'gone' })

    expect(pageStore.revision).toBe(null)
  })

  it('is cleared by a save, whose response carries no revision of its own', async () => {
    // -> A save is exactly what moves the page along its history, so the ordinal this store holds
    //    is out of date the moment the write lands. Absence -- the section falling back to the
    //    author and the time -- is honest where the pre-save count would be a wrong number.
    const { pageStore } = await mountWithPage(pagePayload({ revision: { ordinal: 9 } }))

    const usePageStoreScoped = usePageStore()
    expect(usePageStoreScoped.revision).toEqual({ ordinal: 9 })

    globalThis.API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.resolve({ page: pagePayload({ id: pageStore.id }) })
    })
    await pageStore.pageSave({})

    expect(pageStore.revision).toBe(null)
  })
})

/**
 * OpenProject #2735: the "via MCP" badge, reused verbatim from the history timeline
 * (`PageHistoryOverlay.vue`) -- did the person actually type this revision, or did an MCP tool call
 * acting as them? `revision.via` comes straight off `Page#.revision` (backend half: #2734).
 */
describe('Index.vue: the rail’s “via MCP” badge (#2735)', () => {
  it('draws the badge after the author name for an MCP-authored revision', async () => {
    const { section } = await mountWithPage(
      pagePayload({ revision: { ordinal: 14, changeCount: 6, via: 'mcp' } })
    )

    expect(section.text()).toContain('Dylan Hart')
    expect(section.text()).toContain('via MCP')
  })

  it('draws no badge for an editor-authored revision', async () => {
    const { section } = await mountWithPage(
      pagePayload({ revision: { ordinal: 14, changeCount: 6, via: 'editor' } })
    )

    expect(section.text()).toContain('Dylan Hart')
    expect(section.text()).not.toContain('via MCP')
  })

  it('draws no badge when the reader has no `revision` at all', async () => {
    const { section } = await mountWithPage(pagePayload())

    expect(section.text()).toContain('Dylan Hart')
    expect(section.text()).not.toContain('via MCP')
  })

  it('carries `via` from the page read into `pageStore.revision`, alongside ordinal and changeCount', async () => {
    const { pageStore } = await mountWithPage(
      pagePayload({ revision: { ordinal: 9, changeCount: 3, via: 'mcp' } })
    )

    expect(pageStore.revision).toEqual({ ordinal: 9, changeCount: 3, via: 'mcp' })
  })
})

/**
 * And the strings themselves, read out of what the backend actually serves rather than out of the
 * table above: the component asks for four keys by name and interpolates three placeholders into
 * them, none of which the mounted tests can catch a typo in -- an unknown key renders as its own
 * name and a missing placeholder simply renders nothing.
 */
describe('the Revision section’s locale keys (#2652)', () => {
  const strings = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../backend/locales/en.json'), 'utf-8')
  )

  it('ships the section heading', () => {
    expect(strings['common.page.revision']).toBe('Revision')
  })

  it('takes the ordinal as a placeholder rather than baking a number into the string', () => {
    expect(strings['common.page.revisionOrdinal']).toContain('{ordinal}')
  })

  it('gives the change count both plural forms', () => {
    const forms = strings['common.page.revisionChanges'].split('|').map((form) => form.trim())
    expect(forms).toHaveLength(2)
    expect(forms[1]).toContain('{count}')
  })

  it('reuses the history timeline’s "via MCP" badge strings (#2735), no keys of its own', () => {
    expect(strings['history.viaMcp']).toBe('via MCP')
    expect(strings['history.viaMcpHint']).toContain('MCP tool call')
  })

  it('joins the two clauses through the line key, so the separator is a translator’s', () => {
    expect(strings['common.page.revisionLine']).toContain('{revision}')
    expect(strings['common.page.revisionLine']).toContain('{changes}')
  })
})
