import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

import { buildTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

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

async function mountOverlay({ mockEndpoints = mockGetEndpoints } = {}) {
  mockEndpoints()

  const router = buildTestRouter(['/:pathMatch(.*)*'])

  const { wrapper } = mountWithApp(PageHistoryOverlay, {
    attachTo: document.body,
    router,
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
