import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

/*
  The diff pane is real Monaco, which needs a layout engine happy-dom does not have.
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
  Never reached at runtime -- every version fixture below is `meta.editor: 'html'`, so `renderOf()`
  short-circuits first -- but imported at module scope by the component, which would pull in the
  whole markdown-it plugin chain before a single test runs.
*/
vi.mock('@/renderers/markdown', () => ({ MarkdownRenderer: vi.fn() }))

// -> Real `browser-fs-access` reaches for `showSaveFilePicker` / anchor-click download plumbing, so
//    the download test asserts what was handed to it instead
vi.mock('browser-fs-access', () => ({ fileSave: vi.fn().mockResolvedValue(undefined) }))

import * as monaco from 'monaco-editor'
import { fileSave } from 'browser-fs-access'

import PageHistoryOverlay from './PageHistoryOverlay.vue'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'
import { useDark } from '@/composables/dark'

import { buildTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

const VERSION = {
  id: 'v1',
  action: 'created',
  changedFields: [],
  reason: '',
  versionDate: '2024-01-01T00:00:00.000Z',
  // -> Different from the page's CURRENT locale on purpose: this is what proves `branchFrom` reads
  //    the version's own field rather than `pageStore.locale`
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

function endpointsWithMeta(meta) {
  return () => {
    mockGetEndpoints()
    const base = globalThis.API_CLIENT.get.getMockImplementation()
    globalThis.API_CLIENT.get.mockImplementation((url) =>
      String(url).includes('/history/')
        ? { json: () => Promise.resolve({ ...FULL_VERSION, meta }) }
        : base(url)
    )
  }
}

/*
  `messages` is left undefined by default on purpose: with no catalogue the test i18n renders each
  key as its own path, which is what almost every assertion below matches on. Only the real-layout
  describe passes one, where a label's WIDTH is part of what is being measured.
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
 * `MainOverlayDialog.vue` forwards `siteStore.overlayOpts` to every overlay it mounts as this prop.
 * This one has no use for it but must still declare it, or the value falls through onto its
 * rendered DOM root as a stray attribute.
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

  it('carries the versions page properties through the shared duplicate list', async () => {
    await mountOverlay({
      mockEndpoints: endpointsWithMeta({
        editor: 'html',
        description: 'About',
        icon: 'mdi:home',
        tags: ['a', 'b'],
        relations: [{ id: 'r1', target: 'other' }],
        classification: 'level-2',
        publishState: 'scheduled',
        publishStartDate: '2026-10-01T00:00:00.000Z',
        publishEndDate: '2026-11-01T00:00:00.000Z',
        isBrowsable: false,
        isSearchable: false,
        password: 'bcrypt-verifier',
        alias: 'taken',
        scripts: { jsLoad: 'x()', jsUnload: '', css: 'a{}' },
        config: {
          allowComments: false,
          allowContributions: false,
          showSidebar: false,
          showTags: false,
          showToc: false,
          tocDepth: { min: 2, max: 3 }
        }
      })
    })
    await clickRowAction('history.branchOff')
    const opened = openDialogs.at(-1)

    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ page: { id: 'page-2', path: 'my-page-2' } })
    })
    opened.handlers.ok[0]({ title: 'My Page', path: 'my-page-2' })
    await flushPromises()

    const [, { json }] = globalThis.API_CLIENT.post.mock.calls.at(-1)
    expect(json).toMatchObject({
      description: 'About',
      icon: 'mdi:home',
      tags: ['a', 'b'],
      relations: [{ id: 'r1', target: 'other' }],
      classification: 'level-2',
      publishState: 'scheduled',
      publishStartDate: '2026-10-01T00:00:00.000Z',
      publishEndDate: '2026-11-01T00:00:00.000Z',
      isBrowsable: false,
      isSearchable: false,
      allowComments: false,
      allowContributions: false,
      showSidebar: false,
      showTags: false,
      showToc: false,
      tocDepth: { min: 2, max: 3 }
    })
    for (const key of ['password', 'alias', 'scriptCss', 'scriptJsLoad', 'scriptJsUnload']) {
      expect(json).not.toHaveProperty(key)
    }
  })

  it('drops a schedule that has no scheduled state to go with', async () => {
    await mountOverlay({
      mockEndpoints: endpointsWithMeta({
        editor: 'html',
        publishState: 'draft',
        publishStartDate: '2026-10-01T00:00:00.000Z'
      })
    })
    await clickRowAction('history.branchOff')
    const opened = openDialogs.at(-1)

    globalThis.API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ page: { id: 'page-2', path: 'my-page-2' } })
    })
    opened.handlers.ok[0]({ title: 'My Page', path: 'my-page-2' })
    await flushPromises()

    const [, { json }] = globalThis.API_CLIENT.post.mock.calls.at(-1)
    expect(json.publishState).toBe('draft')
    expect(json).not.toHaveProperty('publishStartDate')
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
    //    `ok: false` rather than rejecting
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
 * Past its computation budget Monaco's diff silently gives up and returns no changes, which reads
 * exactly like two identical versions. `applyDiff` catches the oversized pair before it ever
 * reaches Monaco and shows an honest notice instead.
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
    expect(monaco.editor.createDiffEditor).not.toHaveBeenCalled()
  })

  it('offers a working download for each side of an oversized comparison', async () => {
    const bigVersion = { ...FULL_VERSION, id: OLDER.id, content: 'x'.repeat(600_000) }

    await mountOverlay({ mockEndpoints: mockEndpointsWithOlderVersion(bigVersion) })

    const notice = document.body.querySelector('.page-history-toolarge')
    const buttons = [...notice.querySelectorAll('button')]
    expect(buttons.length).toBe(2)

    // -> The A button, whose content assertion below proves it is wired to the OLDER, oversized
    //    side specifically rather than to something that merely downloads
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
 * A redirect page's content is `{kind, target, showInterstitial}` as JSON (`helpers/pageRedirect.js`),
 * not prose or markup: highlighted as markdown, a target such as `/foo_bar` mis-colours as broken
 * emphasis syntax rather than showing as the plain path it is.
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

  /**
   * `WBadge.vue`'s `outline` styling resolves `color` straight to an inline style, which is why
   * this reads the attribute rather than a class.
   */
  it('renders the "via MCP" badge in the accent color, not slate-pale', async () => {
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

    const badges = [...document.body.querySelectorAll('.page-history-timeline .w-badge')]
    const viaMcpBadge = badges.find((el) => el.textContent.includes('history.viaMcp'))

    expect(viaMcpBadge.getAttribute('style')).toContain('var(--color-accent)')
    expect(viaMcpBadge.getAttribute('style')).not.toContain('var(--color-slate-pale)')
  })

  it('shows no badge on a version whose via is editor (or unset)', async () => {
    await mountOverlay()

    expect(document.body.querySelector('.page-history-timeline').textContent).not.toContain(
      'history.viaMcp'
    )
  })
})

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
    expect(wrapper.findAll('.page-history-item')).toHaveLength(2)
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

describe('PageHistoryOverlay: the header band (OpenProject #2637)', () => {
  it('draws the history glyph at the designs 20px, in the accent rather than the headers white', async () => {
    await mountOverlay()

    const icon = document.body.querySelector('.card-header [data-icon="tabler:history"]')
    // -> `w-icon` sizes itself in `em` off `font-size`, so the inline `font-size` is where the
    //    design's 20px width lands
    expect(icon.style.fontSize).toBe('20px')
    // -> The DARK accent, because this surface is inked in both themes
    expect([...icon.classList]).toContain('text-accent-dark')
  })

  it('leaves the page title in the case its author wrote it, despite the uppercased title band', async () => {
    /*
      A cascade fact -- `.card-header` uppercases a dialog's title band and the page-title span sits
      inside it -- so asserting it needs both halves present. `css/_base.css` is a global sheet no
      component test pulls in, so its one relevant declaration is restated here.
    */
    const baseSheet = document.createElement('style')
    baseSheet.textContent = '.card-header { text-transform: uppercase; }'
    document.head.appendChild(baseSheet)

    try {
      await mountOverlay()

      const band = document.body.querySelector('.card-header')
      const title = document.body.querySelector('.page-history-page')

      // -> The control: without it the next assertion would pass on a band that never uppercased
      expect(getComputedStyle(band).textTransform).toBe('uppercase')
      expect(getComputedStyle(title).textTransform).toBe('none')
    } finally {
      baseSheet.remove()
    }
  })
})

/**
 * `--color-accent-fill` has no dark-mode override anywhere in `tailwind.css`, so the close button
 * resolves its colour through `dark.isActive` rather than a static `accent-fill` prop.
 */
describe('PageHistoryOverlay close button dark mode (OpenProject #2807)', () => {
  afterEach(() => {
    document.body.classList.remove('body--dark', 'body--light')
  })

  it('draws accent-fill under light mode', async () => {
    useDark().set(false)
    await mountOverlay()

    const closeBtn = document.body.querySelector('[aria-label="common.actions.close"]')
    expect(closeBtn.getAttribute('style')).toContain('var(--color-accent-fill)')
    expect(closeBtn.getAttribute('style')).not.toContain('var(--color-accent-dark)')
  })

  it('swaps to accent-dark under dark mode', async () => {
    useDark().set(true)
    await mountOverlay()

    const closeBtn = document.body.querySelector('[aria-label="common.actions.close"]')
    expect(closeBtn.getAttribute('style')).toContain('var(--color-accent-dark)')
    expect(closeBtn.getAttribute('style')).not.toContain('var(--color-accent-fill)')
  })
})

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
  `backend/locales/en.json`'s own values, because a measurement is only worth taking against what
  the app actually renders: the bare `history.versionLabelA` key the test i18n falls back to draws
  far wider than the "A" plate, wide enough to push the A/B column onto a row of its own.
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
    The row only wraps if it is a SIBLING of the dot, the text column and the A/B cursors -- a
    `flex: 0 0 100%` child nested inside the text column would just fill that column instead.
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
    The timestamp and the moved-to path are set in mono and the author's name in the proportional
    face; these classes are the hook the stylesheet hangs the two mono lines off.
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
    `WBadge`'s `rounded` prop is the pill; its non-pill corner is the shared `--radius-mark` token,
    so the square plates the design draws assert `rounded-mark` rather than `rounded-none`.
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
      expect(badge.classList.contains('rounded-mark')).toBe(true)
      expect(badge.classList.contains('rounded-full')).toBe(false)
    }
  })
})

/*
  Everything above is structure; whether the dot is actually 28px and round, or the reason/fields
  row actually lands on a row of its own, needs a layout engine, and neither `happy-dom` nor `jsdom`
  runs one -- every `getBoundingClientRect()` comes back zeroed. Hence a real browser, via
  `test/realGridLayout.js`.

  The page is assembled from `buildAppCss()`'s compiled `src/css/tailwind.css` plus the SFC style
  blocks Vitest has already injected into this environment's `<head>` (`css: true`), which carry the
  dot rules being measured. 380px is the timeline drawer's real width.

  The 30s timeout covers the browser launch and the Tailwind build, paid while other files transform
  in parallel workers.
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
      expect(updated.dotRadius).toBe('50%')
      expect(updated.glyph.width).toBe(14)
      expect(updated.glyph.height).toBe(14)
      /*
        The timeline column's own ground, NOT the diff pane's: the ring's job is to hide the
        timeline line behind the dot, and the wrong ground draws a visible dark halo instead.
      */
      expect(updated.dotRing).toContain('rgb(23, 27, 36)')
      expect(updated.dotRing).toContain('3px')
    })

    it('fills each dot with the designs own tone and the ink that clears it', async () => {
      const [updated, moved, created] = await measureTimeline()

      // -> Dark enough to carry a white glyph
      expect(updated.dotFill).toBe('rgb(95, 120, 168)')
      expect(updated.dotInk).toBe('rgb(255, 255, 255)')
      expect(created.dotFill).toBe('rgb(95, 156, 134)')
      expect(created.dotInk).toBe('rgb(255, 255, 255)')
      // -> A bright fill, so its glyph takes the ink tone instead
      expect(moved.dotFill).toBe('rgb(217, 164, 65)')
      expect(moved.dotInk).toBe('rgb(28, 34, 51)')
    })

    it('wraps the reason and changed-fields onto a row of their own, indented under the text column', async () => {
      const [updated] = await measureTimeline()

      expect(updated.body.top).toBe(updated.dot.top)
      expect(updated.pick.top).toBe(updated.dot.top)
      expect(updated.body.left).toBeGreaterThan(updated.dot.right)
      expect(updated.pick.left).toBeGreaterThanOrEqual(updated.body.right)

      expect(updated.reason.top).toBeGreaterThanOrEqual(updated.dot.bottom)
      expect(updated.fields.top).toBeGreaterThanOrEqual(updated.reason.bottom)

      /*
        The row's 40px indent is exactly the dot plus the row gap, so the edges line up exactly
        rather than merely landing close to one another -- hence equality, not a tolerance.
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

/**
 * Tailwind's global stylesheet is never imported under Vitest, so a `getComputedStyle` assertion
 * cannot observe whether the `dark:` utility actually paints a different colour -- only that the
 * literal class is present on the rendered icon.
 */
describe('PageHistoryOverlay: version-actions menu icons stay legible in dark mode (OpenProject #2741)', () => {
  it('pairs every text-blue-7 menu icon with a literal dark:text-blue-4 counterpart', async () => {
    await mountOverlay()

    const menuBtn = document.body.querySelector('.page-history-pick button')
    await menuBtn.dispatchEvent(new Event('click', { bubbles: true }))
    await flushPromises()

    const iconNames = [
      'tabler:square-letter-a',
      'tabler:square-letter-b',
      'tabler:code',
      'tabler:download',
      'tabler:git-branch'
    ]
    for (const name of iconNames) {
      const icon = document.body.querySelector(`.w-menu [data-icon="${name}"]`)
      expect(icon, name).not.toBeNull()
      expect([...icon.classList], name).toContain('text-blue-7')
      expect([...icon.classList], name).toContain('dark:text-blue-4')
    }
  })
})

/**
 * This overlay is drawn on ink in both site THEMES by design, so its colours have to come from the
 * `--color-*` custom properties `css/tailwind.css` swaps per AESTHETIC rather than from values
 * frozen at Ledger's. The site accent and the site-brand primary are the same tone in Ledger and
 * different ones under Cobalt, which is what makes confusing them invisible until then.
 *
 * No compiled stylesheet exists in this environment for a computed-style assertion to resolve
 * `var()` cascades against, so the stylesheet half is checked against the component's own source
 * text, the way `css/cobaltTokens.test.js` checks a hand-edited token file.
 */
describe('PageHistoryOverlay Cobalt aesthetic conformance (OpenProject #2776)', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'PageHistoryOverlay.vue')
  const source = readFileSync(SOURCE_PATH, 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'))

  it('fills the "Current" badge with the white-text accent, not the site primary color', async () => {
    await mountOverlay()

    const badge = document.body.querySelector('.page-history-item .w-badge')
    expect(badge).not.toBeNull()
    expect(badge.style.backgroundColor).toBe('var(--color-accent)')
  })

  it('marks a picked/current timeline row with the untexted accent fill, not the site primary color', () => {
    expect(styleBlock).toMatch(
      /\.page-history-item\.is-picked\s*{\s*background-color:\s*color-mix\(in srgb, var\(--color-accent-fill\) 16%, transparent\);\s*box-shadow:\s*inset 3px 0 0 var\(--color-accent-fill\);/
    )
  })

  it('fills the A/B compare-bar letter plates with the white-text accent, not the site primary color', () => {
    expect(styleBlock).toMatch(
      /\.page-history-letter\s*{[^}]*background-color:\s*var\(--color-accent\);/
    )
  })

  it('reads the aesthetic-aware dark custom properties, not the frozen Ledger Sass constants', () => {
    // -> One representative per role; a miss on any of them means the ink-drawn diff/timeline
    //    stopped following the site's aesthetic
    for (const token of [
      '--color-dark-2',
      '--color-dark-4',
      '--color-dark-5',
      '--color-hairline-dark',
      '--color-text-dark',
      '--color-text-secondary-dark',
      '--color-text-caption-dark',
      '--color-positive-fill',
      '--color-warning-fill',
      '--color-negative-fill',
      '--color-slate-soft',
      '--color-ink'
    ]) {
      expect(styleBlock).toContain(`var(${token})`)
    }
  })
})

/**
 * Under Cobalt these two groups get a real gap between their buttons, so `WBtnGroup.vue`'s seam
 * hairline -- meant for touching squares -- no longer belongs and is switched off for them.
 * Checked against the component's own source text, since no compiled token stylesheet exists here.
 */
describe('PageHistoryOverlay Cobalt polish: toggle/chip spacing (OpenProject #2872)', () => {
  const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'PageHistoryOverlay.vue')
  const source = readFileSync(SOURCE_PATH, 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'))

  it('marks the Side by side/Inline toggle with the class the Cobalt gap rule targets', async () => {
    await mountOverlay()

    const toggle = document.body.querySelector('.page-history-toggle')
    expect(toggle).not.toBeNull()
    expect(toggle.querySelectorAll('.w-btn')).toHaveLength(2)
  })

  it('gives the toggle a 10px gap and the A/B pick chips a 4px gap, Cobalt only', () => {
    expect(styleBlock).toMatch(/body\.body--cobalt \.page-history-toggle\s*{\s*gap:\s*10px;/)
    expect(styleBlock).toMatch(/body\.body--cobalt \.page-history-pick-group\s*{\s*gap:\s*4px;/)
  })

  it('drops the shared btn-group seam hairline for both groups once they have a real gap', () => {
    expect(styleBlock).toMatch(
      /body\.body--cobalt \.page-history-toggle \.w-btn:not\(:last-child\),\s*body\.body--cobalt \.page-history-pick-group \.w-btn:not\(:last-child\)\s*{\s*border-inline-end:\s*none;/
    )
  })
})
