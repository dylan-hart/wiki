import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

/*
  The diff pane is real Monaco, which needs a layout engine this test has no reason to drag in -- the
  shared VERSION/FULL_VERSION fixtures below carry `meta.editor: 'html'` specifically so `renderOf()`
  never reaches the markdown pipeline either (a redirect-editor fixture appears in one test further
  down, but only on the applyDiff path, which never calls `renderOf()`), and this is the only thing
  standing between mounting and a DOM Monaco cannot use under happy-dom.
*/
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    createDiffEditor: vi.fn(() => ({
      setModel: vi.fn(),
      updateOptions: vi.fn(),
      dispose: vi.fn()
    })),
    createModel: vi.fn(() => ({ dispose: vi.fn() }))
  }
}))

/*
  Never reached at runtime here -- every version below has `meta.editor: 'html'`, so `renderOf()`
  short-circuits before touching this -- but it is still imported at module scope by
  `PageHistoryOverlay.vue`, and pulls in `markdown-it-mdc`, which breaks on this environment's
  `markdown-it` version (a subpath-exports mismatch unrelated to this task). Stubbed so importing the
  component under test doesn't fail before a single test runs.
*/
vi.mock('@/renderers/markdown', () => ({ MarkdownRenderer: vi.fn() }))

// -> Real `browser-fs-access` reaches for `showSaveFilePicker` / anchor-click download plumbing this
//    environment has no reason to exercise; mocked so a download test can assert what was handed to
//    it instead of what a real save dialog would have done with it.
vi.mock('browser-fs-access', () => ({ fileSave: vi.fn().mockResolvedValue(undefined) }))

// -> The mocked modules' own `vi.fn()`s, so a test can assert what the component asked them to do
import * as monaco from 'monaco-editor'
import { fileSave } from 'browser-fs-access'

import PageHistoryOverlay from './PageHistoryOverlay.vue'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { buildTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * Regression coverage for task 516: `branchFrom`'s destination locale, and the three failure shapes
 * `restoreVersion`/`branchFrom` must surface as an actionable caption rather than a bare toast.
 */

const VERSION = {
  id: 'v1',
  action: 'created',
  changedFields: [],
  reason: '',
  versionDate: '2024-01-01T00:00:00.000Z',
  // -> Different from the page's CURRENT locale on purpose -- this is what proves `branchFrom` reads
  //    the version's own field rather than the hardcoded `pageStore.locale` it used to.
  locale: 'fr',
  path: 'my-page',
  title: 'My Page',
  author: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' }
}

const FULL_VERSION = {
  ...VERSION,
  content: '<p>Bonjour</p>',
  meta: { editor: 'html', description: '', icon: '', tags: [], publishState: 'published' }
}

function mockGetEndpoints() {
  globalThis.API_CLIENT.get.mockImplementation((url) => {
    if (String(url).endsWith('/history')) {
      return { json: () => Promise.resolve({ items: [VERSION], nextCursor: null }) }
    }
    if (String(url).includes('/history/')) {
      return { json: () => Promise.resolve(FULL_VERSION) }
    }
    // -> `pageStore.pageLoad()` (restoreVersion's post-save refresh)
    return { json: () => Promise.resolve({ id: 'page-1' }) }
  })
}

/*
  `messages` is left undefined by default on purpose: with no catalogue the test i18n renders each
  key as its own path, which is what almost every assertion below matches on. The one caller that
  passes it is the real-layout describe, where a label's WIDTH is part of what is being measured and
  `history.versionLabelA` is nothing like the "A" the app actually draws.
*/
async function mountOverlay({ mockEndpoints = mockGetEndpoints, overlayOpts, messages } = {}) {
  mockEndpoints()

  const router = buildTestRouter(['/:pathMatch(.*)*'])

  const { wrapper } = mountWithApp(PageHistoryOverlay, {
    attachTo: document.body,
    router,
    ...(messages ? { messages } : {}),
    ...(overlayOpts ? { props: { overlayOpts } } : {}),
    stores: {
      page: (store) => {
        store.$patch({
          id: 'page-1',
          path: 'my-page',
          title: 'My Page',
          locale: 'en',
          editor: 'html'
        })
      },
      site: { id: 'site-1' },
      user: (store) => {
        store.$patch({ permissions: ['write:pages'] })
      }
    }
  })
  await flushPromises()

  return { wrapper, router }
}

/** Opens the row's "..." menu and clicks the named action inside it. */
async function clickRowAction(label) {
  const menuBtn = document.body.querySelector('.page-history-pick button')
  await menuBtn.dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()

  const item = [...document.body.querySelectorAll('.w-menu [role], .w-menu span')].find(
    (el) => el.textContent.trim() === label
  )
  const clickable = item.closest('[role="button"]') ?? item
  await clickable.dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  openDialogs.splice(0, openDialogs.length)
  notifyQueue.splice(0, notifyQueue.length)
  document.body.innerHTML = ''
  // -> The mocked modules live at module scope, so their call history otherwise leaks between tests
  monaco.editor.createDiffEditor.mockClear()
  monaco.editor.createModel.mockClear()
  fileSave.mockClear()
})

/**
 * OpenProject #2530: `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it
 * mounts as this prop -- this overlay has no use for it, but must still declare it, or the value
 * falls through onto its rendered DOM root as a stray attribute.
 */
describe('PageHistoryOverlay overlayOpts prop (OpenProject #2530)', () => {
  it('declares overlayOpts as a prop, so it does not fall through onto the rendered DOM root', async () => {
    const { wrapper } = await mountOverlay({ overlayOpts: { unused: true } })

    expect(wrapper.attributes('overlay-opts')).toBeUndefined()
  })
})

describe('PageHistoryOverlay: branchFrom', () => {
  it('creates the branch at the versions own locale, not the pages current one', async () => {
    await mountOverlay()
    await clickRowAction('history.branchOff')

    const opened = openDialogs.at(-1)
    expect(opened.props).toMatchObject({ mode: 'duplicatePage' })

    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ page: { id: 'page-2', path: 'my-page-2' } })
    })
    opened.handlers.ok[0]({ title: 'My Page', path: 'my-page-2' })
    await flushPromises()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/pages',
      expect.objectContaining({ json: expect.objectContaining({ locale: 'fr' }) })
    )
  })

  it('surfaces a write:pages 403 as its own actionable message, not a bare failure toast', async () => {
    await mountOverlay()
    await clickRowAction('history.branchOff')
    const opened = openDialogs.at(-1)

    const err = Object.assign(new Error('Forbidden'), {
      data: {
        ok: false,
        error: 'ForbiddenError',
        statusCode: 403,
        message: 'You are not allowed to create a page here.'
      }
    })
    globalThis.API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.reject(err) })
    opened.handlers.ok[0]({ title: 'My Page', path: 'someone-elses-page' })
    await flushPromises()

    const toast = notifyQueue.at(-1)
    expect(toast.type).toBe('negative')
    expect(toast.caption).toBe('You are not allowed to create a page here.')
  })

  it('surfaces a pageDuplicatePath 409 as its own actionable message', async () => {
    await mountOverlay()
    await clickRowAction('history.branchOff')
    const opened = openDialogs.at(-1)

    const err = Object.assign(new Error('Conflict'), {
      data: {
        ok: false,
        error: 'pageDuplicatePath',
        statusCode: 409,
        message: 'A page already exists at this path.'
      }
    })
    globalThis.API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.reject(err) })
    opened.handlers.ok[0]({ title: 'My Page', path: 'my-page' })
    await flushPromises()

    const toast = notifyQueue.at(-1)
    expect(toast.caption).toBe('A page already exists at this path.')
  })

  it('surfaces a pageInvalidLocale 400 as its own actionable message', async () => {
    await mountOverlay()
    await clickRowAction('history.branchOff')
    const opened = openDialogs.at(-1)

    // -> `throwHttpErrors` (boot/api.js) does not throw for exactly 400, so this resolves with
    //    `ok: false` rather than rejecting -- `branchFrom` reads that off `resp.message`.
    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: false,
          error: 'pageInvalidLocale',
          statusCode: 400,
          message: 'This site does not have the "fr" locale enabled.'
        })
    })
    opened.handlers.ok[0]({ title: 'My Page', path: 'my-page-2' })
    await flushPromises()

    const toast = notifyQueue.at(-1)
    expect(toast.caption).toBe('This site does not have the "fr" locale enabled.')
  })
})

describe('PageHistoryOverlay: restoreVersion', () => {
  it('surfaces a write:pages 403 as its own actionable message', async () => {
    await mountOverlay()

    globalThis.API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.reject(
          Object.assign(new Error('Forbidden'), {
            data: {
              ok: false,
              error: 'ForbiddenError',
              statusCode: 403,
              message: 'You are not allowed to edit this page.'
            }
          })
        )
    })

    await clickRowAction('history.restore')
    // -> The confirm() dialog opened by `restoreVersion`; simulate its own OK
    const confirmDialog = openDialogs.at(-1)
    confirmDialog.handlers.ok[0](true)
    await flushPromises()

    const toast = notifyQueue.at(-1)
    expect(toast.caption).toBe('You are not allowed to edit this page.')
  })

  it('never sends an editor field, so a same-page restore cannot hit an editor-type mismatch', async () => {
    await mountOverlay()

    globalThis.API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.resolve({ page: { id: 'page-1' } })
    })

    await clickRowAction('history.restore')
    const confirmDialog = openDialogs.at(-1)
    confirmDialog.handlers.ok[0](true)
    await flushPromises()

    const [, body] = globalThis.API_CLIENT.patch.mock.calls.at(-1)
    expect(body.json).not.toHaveProperty('editor')
  })
})

/**
 * Task 518: at the scale a real large page reaches (tens of thousands of lines/characters), Monaco's
 * own diff computation does not freeze the tab -- it runs in a worker -- but past its computation
 * budget it silently gives up and returns no changes, which reads exactly like two identical versions.
 * `applyDiff` catches the pair before it ever reaches Monaco and shows an honest notice instead.
 */
describe('PageHistoryOverlay: diff too large to render inline', () => {
  const OLDER = { ...VERSION, id: 'v0', versionDate: '2023-12-31T00:00:00.000Z' }

  function mockEndpointsWithOlderVersion(olderFull) {
    return () => {
      globalThis.API_CLIENT.get.mockImplementation((url) => {
        if (String(url).endsWith('/history')) {
          return { json: () => Promise.resolve({ items: [VERSION, OLDER], nextCursor: null }) }
        }
        if (String(url).includes(`/history/${OLDER.id}`)) {
          return { json: () => Promise.resolve(olderFull) }
        }
        if (String(url).includes('/history/')) {
          return { json: () => Promise.resolve(FULL_VERSION) }
        }
        return { json: () => Promise.resolve({ id: 'page-1' }) }
      })
    }
  }

  it('skips Monaco and shows a download notice when a version exceeds the inline size limit', async () => {
    const bigVersion = { ...FULL_VERSION, id: OLDER.id, content: 'x'.repeat(600_000) }

    const { wrapper } = await mountOverlay({
      mockEndpoints: mockEndpointsWithOlderVersion(bigVersion)
    })

    expect(wrapper.text()).toContain('history.diffTooLarge')
    expect(monaco.editor.createModel).not.toHaveBeenCalled()
    // -> The container stays mounted (hidden), never handed a model
    expect(monaco.editor.createDiffEditor).not.toHaveBeenCalled()
  })

  it('offers a working download for each side of an oversized comparison', async () => {
    const bigVersion = { ...FULL_VERSION, id: OLDER.id, content: 'x'.repeat(600_000) }

    await mountOverlay({ mockEndpoints: mockEndpointsWithOlderVersion(bigVersion) })

    const notice = document.body.querySelector('.page-history-toolarge')
    const buttons = [...notice.querySelectorAll('button')]
    expect(buttons.length).toBe(2)

    // -> The A button: proves it is wired to the OLDER, oversized side specifically, not just to
    //    something that happens to download
    await buttons[0].dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(fileSave).toHaveBeenCalledTimes(1)
    const [blob] = fileSave.mock.calls[0]
    expect(await blob.text()).toBe(bigVersion.content)
  })

  it('still renders an ordinary, well-under-the-limit comparison through Monaco', async () => {
    await mountOverlay()

    expect(monaco.editor.createModel).toHaveBeenCalled()
    expect(document.body.querySelector('.page-history-toolarge')).toBeNull()
  })
})

/**
 * Task 518: a redirect page's content is `{kind, target, showInterstitial}` as JSON (see
 * `helpers/pageRedirect.js`), not prose or markup. `languageOf`'s two-way html/markdown mapping used to
 * fall this through to `markdown`, which mis-colours a target such as `/foo_bar` as broken emphasis
 * syntax rather than showing it as the plain path it is.
 */
describe('PageHistoryOverlay: languageOf for a redirect-editor page', () => {
  it('colours a redirect versions diff as JSON, not markdown', async () => {
    const redirectContent = JSON.stringify({
      kind: 'page',
      target: '/foo_bar',
      showInterstitial: false
    })
    const redirectVersion = {
      ...VERSION,
      content: redirectContent,
      meta: { editor: 'redirect', description: '', icon: '', tags: [], publishState: 'published' }
    }

    await mountOverlay({
      mockEndpoints: () => {
        globalThis.API_CLIENT.get.mockImplementation((url) => {
          if (String(url).endsWith('/history')) {
            return { json: () => Promise.resolve({ items: [VERSION], nextCursor: null }) }
          }
          if (String(url).includes('/history/')) {
            return { json: () => Promise.resolve(redirectVersion) }
          }
          return { json: () => Promise.resolve({ id: 'page-1' }) }
        })
      }
    })

    const languages = monaco.editor.createModel.mock.calls.map(([, language]) => language)
    expect(languages).toEqual(['json', 'json'])
  })
})

/**
 * OpenProject #811: defense in depth for `load()` -- an empty history list (which is what an
 * unsaved page's `id` would fetch, were the overlay ever reached with one) must not crash indexing
 * `state.versions[0]`, and must not raise a "failed to load" toast either, since nothing failed.
 */
/**
 * OpenProject #1119: page-history provenance -- a reader looking at the timeline must be able to tell
 * an MCP-authored version apart from one typed into the editor.
 */
describe('PageHistoryOverlay: MCP provenance marker', () => {
  it('shows a "via MCP" badge on a version whose via is mcp', async () => {
    const mcpVersion = { ...VERSION, via: 'mcp' }
    await mountOverlay({
      mockEndpoints: () => {
        globalThis.API_CLIENT.get.mockImplementation((url) => {
          if (String(url).endsWith('/history')) {
            return { json: () => Promise.resolve({ items: [mcpVersion], nextCursor: null }) }
          }
          return { json: () => Promise.resolve({ ...FULL_VERSION, via: 'mcp' }) }
        })
      }
    })

    expect(document.body.querySelector('.page-history-timeline').textContent).toContain(
      'history.viaMcp'
    )
  })

  it('shows no badge on a version whose via is editor (or unset)', async () => {
    await mountOverlay()

    expect(document.body.querySelector('.page-history-timeline').textContent).not.toContain(
      'history.viaMcp'
    )
  })
})

/**
 * OpenProject #1859: `pageHistory.list` is now keyset-paginated rather than returning the whole
 * history in one call, so the overlay has to fetch further pages itself.
 */
describe('PageHistoryOverlay: cursor pagination', () => {
  const OLDER = { ...VERSION, id: 'v0', versionDate: '2023-12-31T00:00:00.000Z' }

  it('shows a "load more" control when the first page has a nextCursor, and hides it once exhausted', async () => {
    const { wrapper } = await mountOverlay({
      mockEndpoints: () => {
        globalThis.API_CLIENT.get.mockImplementation((url, opts) => {
          if (String(url).endsWith('/history') && !opts?.searchParams) {
            return { json: () => Promise.resolve({ items: [VERSION], nextCursor: 'cursor-1' }) }
          }
          if (String(url).endsWith('/history') && opts?.searchParams?.cursor === 'cursor-1') {
            return { json: () => Promise.resolve({ items: [OLDER], nextCursor: null }) }
          }
          return { json: () => Promise.resolve(FULL_VERSION) }
        })
      }
    })

    const loadMoreBtn = () => document.body.querySelector('.page-history-load-more button')
    expect(loadMoreBtn()).not.toBeNull()

    await loadMoreBtn().dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      'sites/site-1/pages/page-1/history',
      expect.objectContaining({ searchParams: { cursor: 'cursor-1' } })
    )
    // -> The older page's entry is now on the timeline, appended after the first page's
    expect(wrapper.findAll('.page-history-item')).toHaveLength(2)
    // -> nextCursor came back null, so there is nothing left to load
    expect(loadMoreBtn()).toBeNull()
  })

  it('shows no "load more" control when the first page has no nextCursor', async () => {
    await mountOverlay()
    expect(document.body.querySelector('.page-history-load-more')).toBeNull()
  })
})

describe('PageHistoryOverlay: no history yet', () => {
  it('shows the empty-history notice instead of crashing on an empty version list', async () => {
    const { wrapper } = await mountOverlay({
      mockEndpoints: () => {
        globalThis.API_CLIENT.get.mockImplementation((url) => {
          if (String(url).endsWith('/history')) {
            return { json: () => Promise.resolve({ items: [], nextCursor: null }) }
          }
          return { json: () => Promise.resolve({ id: 'page-1' }) }
        })
      }
    })

    expect(wrapper.find('.page-history-timeline').exists()).toBe(false)
    expect(notifyQueue).toHaveLength(0)
  })
})

/**
 * OpenProject #2637, notes 1 and 2 of Dylan's 2026-09-05 review: "the PAGE HISTORY icon is too
 * large; the mockup defines it smaller and accent-colored. the page title in the dialog is normal
 * case, not uppercased, in the mockup."
 *
 * Both are read off `ui-redesign/Cardinal Wiki - History 3x.dc.html`'s own header row.
 */
describe('PageHistoryOverlay: the header band (OpenProject #2637)', () => {
  it('draws the history glyph at the designs 20px, in the accent rather than the headers white', async () => {
    await mountOverlay()

    const icon = document.body.querySelector('.card-header [data-icon="tabler:history"]')
    /*
      `w-icon` sizes itself in `em` off `font-size`, so 20px here IS the design's `width="20"`. It was
      `size="md"` -- 32px, per `components/shared/metrics.js` -- which is what made it read as chrome
      rather than as a mark beside the label.
    */
    expect(icon.style.fontSize).toBe('20px')
    // -> `color="accent-dark"`, the `#f08287` the design strokes it in; see the template's own note
    //    on why the DARK accent is the right one on a surface that is inked in both themes
    expect([...icon.classList]).toContain('text-accent-dark')
  })

  it('leaves the page title in the case its author wrote it, despite the uppercased title band', async () => {
    /*
      `.card-header` uppercases a dialog's title band (`css/_base.scss`), and the page-title span sits
      inside it -- so this is a cascade fact, and asserting it needs both halves present. The overlay
      brings its own stylesheet with it (Vitest's `css: true`), but `_base.scss` is a global sheet the
      app loads in `main.js` and no component test pulls in, so its one relevant declaration is
      restated here rather than the whole file being imported for it.
    */
    const baseSheet = document.createElement('style')
    baseSheet.textContent = '.card-header { text-transform: uppercase; }'
    document.head.appendChild(baseSheet)

    try {
      await mountOverlay()

      const band = document.body.querySelector('.card-header')
      const title = document.body.querySelector('.page-history-page')

      // -> The control: the band itself really is uppercased, so the next assertion means something
      expect(getComputedStyle(band).textTransform).toBe('uppercase')
      expect(getComputedStyle(title).textTransform).toBe('none')
    } finally {
      baseSheet.remove()
    }
  })
})

/**
 * OpenProject #2622 -- item 3 of `docs/cardinal-reskin-second-pass.md`'s "Still to do" list: the
 * timeline entry's own layout, against `ui-redesign/Cardinal Wiki - History 3x.dc.html`.
 *
 * The design draws one entry as a 28px round action dot, a text column and the A/B cursors on one
 * row, with the reason and the changed-fields list wrapped onto a row of their own beneath them,
 * indented to start under the text column rather than under the dot. What each of the three dot
 * kinds is filled with, and which ink its glyph takes, come from the same file.
 */
const TIMELINE_VERSIONS = [
  {
    ...VERSION,
    id: 'v3',
    action: 'updated',
    versionDate: '2024-03-03T16:12:00.000Z',
    reason: 'Added the health gate flag to the rollout command.',
    changedFields: ['content', 'description']
  },
  {
    ...VERSION,
    id: 'v2',
    action: 'moved',
    versionDate: '2024-02-02T11:02:00.000Z',
    path: 'docs/ingest/workers'
  },
  { ...VERSION, id: 'v1', action: 'created', versionDate: '2024-01-01T09:15:00.000Z' }
]

/*
  `backend/locales/en.json`'s own values for every string the timeline entry draws. A measurement is
  only worth taking against what the app actually renders: "A" and "B" are 24px plates, where the
  bare `history.versionLabelA` key the test i18n falls back to is a 155px one, wide enough to push
  the whole A/B column onto a row of its own.
*/
const TIMELINE_MESSAGES = {
  'history.action.created': 'Created',
  'history.action.moved': 'Moved',
  'history.action.updated': 'Updated',
  'history.changedFields': 'Changed: {fields}',
  'history.current': 'Current',
  'history.loadMore': 'Load older versions',
  'history.unknownAuthor': 'Unknown',
  'history.versionActions': 'Version Actions',
  'history.versionLabelA': 'A',
  'history.versionLabelB': 'B',
  'history.viaMcp': 'via MCP'
}

function mockTimelineEndpoints() {
  globalThis.API_CLIENT.get.mockImplementation((url) => {
    if (String(url).endsWith('/history')) {
      return { json: () => Promise.resolve({ items: TIMELINE_VERSIONS, nextCursor: null }) }
    }
    if (String(url).includes('/history/')) {
      return { json: () => Promise.resolve(FULL_VERSION) }
    }
    return { json: () => Promise.resolve({ id: 'page-1' }) }
  })
}

describe('PageHistoryOverlay timeline entry: structure', () => {
  it('gives each dot the components own action class rather than a background utility', async () => {
    const { wrapper } = await mountOverlay({ mockEndpoints: mockTimelineEndpoints })

    const dots = wrapper.findAll('.page-history-dot')
    expect(dots.map((dot) => dot.classes().join(' '))).toEqual([
      'page-history-dot is-updated',
      'page-history-dot is-moved',
      'page-history-dot is-created'
    ])
  })

  it('falls back to the unclassified dot for an action this build has no name for', async () => {
    const { wrapper } = await mountOverlay({
      mockEndpoints: () => {
        globalThis.API_CLIENT.get.mockImplementation((url) => {
          if (String(url).endsWith('/history')) {
            return {
              json: () =>
                Promise.resolve({
                  items: [{ ...VERSION, action: 'reticulated' }],
                  nextCursor: null
                })
            }
          }
          return { json: () => Promise.resolve(FULL_VERSION) }
        })
      }
    })

    expect(wrapper.find('.page-history-dot').classes()).toContain('is-other')
  })

  /*
    The wrapped row only wraps if it is a SIBLING of the dot, the text column and the A/B cursors --
    a `flex: 0 0 100%` child nested inside the text column would just fill that column instead.
  */
  it('puts the reason/fields row on the entry itself, beside the dot rather than inside the text column', async () => {
    await mountOverlay({ mockEndpoints: mockTimelineEndpoints })

    const entry = document.body.querySelector('.page-history-item')
    expect([...entry.children].map((el) => el.className)).toEqual([
      'page-history-dot is-updated',
      'page-history-body',
      'page-history-pick',
      'page-history-notes'
    ])
    expect(entry.querySelector('.page-history-body .page-history-notes')).toBeNull()
  })

  it('draws no reason/fields row on an entry that has neither', async () => {
    await mountOverlay({ mockEndpoints: mockTimelineEndpoints })

    const entries = document.body.querySelectorAll('.page-history-item')
    expect(entries[0].querySelector('.page-history-notes')).not.toBeNull()
    expect(entries[1].querySelector('.page-history-notes')).toBeNull()
    expect(entries[2].querySelector('.page-history-notes')).toBeNull()
  })

  /*
    The design sets the timestamp and the moved-to path in mono and the author's name in the
    proportional face; all three used to be one `.page-history-meta` class, so the whole block came
    out proportional. These classes are the hook the stylesheet hangs the two mono lines off.
  */
  it('marks the timestamp and the moved-to path as the entrys mono lines', async () => {
    await mountOverlay({ mockEndpoints: mockTimelineEndpoints })

    const entries = document.body.querySelectorAll('.page-history-item')
    expect(entries[0].querySelector('.page-history-time')).not.toBeNull()
    // -> Only a move has somewhere it went; an update and a create draw no path line at all
    expect(entries[0].querySelector('.page-history-path')).toBeNull()
    expect(entries[1].querySelector('.page-history-path').textContent.trim()).toBe(
      '/docs/ingest/workers'
    )
  })

  /*
    Cardinal zeroes every radius but a genuinely round shape, and the design draws both of the
    entry's markers as square mono plates. `WBadge`'s `rounded` prop is the pill.
  */
  it('draws the current and via-MCP markers as square plates, not pills', async () => {
    await mountOverlay({
      mockEndpoints: () => {
        globalThis.API_CLIENT.get.mockImplementation((url) => {
          if (String(url).endsWith('/history')) {
            return {
              json: () => Promise.resolve({ items: [{ ...VERSION, via: 'mcp' }], nextCursor: null })
            }
          }
          return { json: () => Promise.resolve({ ...FULL_VERSION, via: 'mcp' }) }
        })
      }
    })

    const badges = [...document.body.querySelectorAll('.page-history-item .w-badge')]
    expect(badges).toHaveLength(2)
    for (const badge of badges) {
      expect(badge.classList.contains('rounded-none')).toBe(true)
      expect(badge.classList.contains('rounded-full')).toBe(false)
    }
  })
})

/*
  Everything above is structure; none of it can answer whether the dot is actually 28px and round,
  or whether the reason/fields row actually lands on a row of its own under the text column. Neither
  `happy-dom` nor `jsdom` runs a layout engine -- every `getBoundingClientRect()` comes back zeroed
  -- so a measurement claim needs a real browser, which is what `test/realGridLayout.js` is for.

  The page is assembled from two stylesheets: `buildAppCss()` compiles the app's own
  `src/css/tailwind.css` exactly as the production build does, and the SFC style blocks Vitest has
  already compiled (`css: true`) and injected into this environment's `<head>` carry the component's
  own SCSS -- including the dot rules, which is the half being measured. 380px is the timeline
  drawer's real width (`<w-drawer :width="380">`).

  The 30s suite timeout is the same allowance `ApiKeyCreateDialog.test.js` documents: the browser
  launch and the Tailwind build are paid for while seven other files transform in parallel workers.
*/
describe(
  'PageHistoryOverlay timeline entry — real layout',
  { skip: !hasChromium(), timeout: 30000 },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    /** Mounts the three-entry timeline, renders it at the drawer's real width and measures it. */
    async function measureTimeline() {
      await mountOverlay({ mockEndpoints: mockTimelineEndpoints, messages: TIMELINE_MESSAGES })

      const timeline = document.body.querySelector('.page-history-timeline').outerHTML
      const sfcCss = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
      const appCss = await buildAppCss()

      const page = await browser.newPage()
      try {
        await page.setContent(
          '<!doctype html><html><head>' +
            `<style>${appCss}</style><style>${sfcCss}</style>` +
            '</head><body style="margin:0;background:#171b24">' +
            `<div style="width:380px">${timeline}</div>` +
            '</body></html>'
        )
        return await page.evaluate(() => {
          const rect = (el) => {
            if (!el) {
              return null
            }
            const r = el.getBoundingClientRect()
            return {
              top: Math.round(r.top),
              left: Math.round(r.left),
              right: Math.round(r.right),
              bottom: Math.round(r.bottom),
              width: Math.round(r.width),
              height: Math.round(r.height)
            }
          }
          const font = (el) => (el ? getComputedStyle(el).fontFamily : null)

          return [...document.querySelectorAll('.page-history-item')].map((entry) => {
            const dot = entry.querySelector('.page-history-dot')
            const dotStyle = getComputedStyle(dot)
            // -> [timestamp, author, path?] -- the first and last carry their own class as well
            const metas = entry.querySelectorAll('.page-history-meta')
            return {
              entry: rect(entry),
              dot: rect(dot),
              dotRadius: dotStyle.borderTopLeftRadius,
              dotFill: dotStyle.backgroundColor,
              dotInk: dotStyle.color,
              dotRing: dotStyle.boxShadow,
              glyph: rect(dot.querySelector('.w-icon')),
              body: rect(entry.querySelector('.page-history-body')),
              pick: rect(entry.querySelector('.page-history-pick')),
              reason: rect(entry.querySelector('.page-history-reason')),
              fields: rect(entry.querySelector('.page-history-fields')),
              timeFont: font(entry.querySelector('.page-history-time')),
              authorFont: font(metas[1]),
              pathFont: font(entry.querySelector('.page-history-path')),
              fieldsFont: font(entry.querySelector('.page-history-fields'))
            }
          })
        })
      } finally {
        await page.close()
      }
    }

    it('draws a 28px round action dot ringed in the timeline columns own ground', async () => {
      const [updated] = await measureTimeline()

      expect(updated.dot.width).toBe(28)
      expect(updated.dot.height).toBe(28)
      // -> `border-radius: 50%` of a 28px box; anything less is a rounded square, not a dot
      expect(updated.dotRadius).toBe('50%')
      // -> The design's 14px glyph, centred in the 28px plate
      expect(updated.glyph.width).toBe(14)
      expect(updated.glyph.height).toBe(14)
      /*
        $dark-4 (#171b24), the timeline column's ground -- NOT $dark-5 (#14171f), the diff pane's,
        which is what this was and which drew a visible dark halo instead of hiding the line behind
        the dot.
      */
      expect(updated.dotRing).toContain('rgb(23, 27, 36)')
      expect(updated.dotRing).toContain('3px')
    })

    it('fills each dot with the designs own tone and the ink that clears it', async () => {
      const [updated, moved, created] = await measureTimeline()

      // -> #5f78a8 / #5f9c86: dark enough to carry the white glyph the design draws on them
      expect(updated.dotFill).toBe('rgb(95, 120, 168)')
      expect(updated.dotInk).toBe('rgb(255, 255, 255)')
      expect(created.dotFill).toBe('rgb(95, 156, 134)')
      expect(created.dotInk).toBe('rgb(255, 255, 255)')
      // -> #d9a441 is a bright fill, so its glyph takes $ink (#1c2233) -- as the design draws it
      expect(moved.dotFill).toBe('rgb(217, 164, 65)')
      expect(moved.dotInk).toBe('rgb(28, 34, 51)')
    })

    it('wraps the reason and changed-fields onto a row of their own, indented under the text column', async () => {
      const [updated] = await measureTimeline()

      // -> The dot, the text column and the A/B cursors are one row: same top, in that order
      expect(updated.body.top).toBe(updated.dot.top)
      expect(updated.pick.top).toBe(updated.dot.top)
      expect(updated.body.left).toBeGreaterThan(updated.dot.right)
      expect(updated.pick.left).toBeGreaterThanOrEqual(updated.body.right)

      // -> ...and the reason/fields are NOT: they start below the dot, on their own row
      expect(updated.reason.top).toBeGreaterThanOrEqual(updated.dot.bottom)
      expect(updated.fields.top).toBeGreaterThanOrEqual(updated.reason.bottom)

      /*
        Indented to start under the entry's text rather than under its dot -- the 40px the design
        gives the row is exactly the dot plus the row gap, so the two edges line up rather than
        merely landing close to one another.
      */
      expect(updated.reason.left).toBe(updated.body.left)
      expect(updated.fields.left).toBe(updated.body.left)
      expect(updated.reason.left - updated.entry.left).toBe(56) // 16px entry padding + 40px indent
    })

    it('sets the timestamp, the moved-to path and the changed fields in mono, and the author beside them in the proportional face', async () => {
      const [updated, moved] = await measureTimeline()

      expect(updated.timeFont).toContain('Roboto Mono')
      expect(updated.fieldsFont).toContain('Roboto Mono')
      expect(moved.pathFont).toContain('Roboto Mono')
      expect(updated.authorFont).not.toContain('Roboto Mono')
    })
  }
)
