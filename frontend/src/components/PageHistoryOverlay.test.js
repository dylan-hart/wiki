import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'

/*
  The diff pane is real Monaco, which needs a layout engine this test has no reason to drag in --
  every version below carries `meta.editor: 'html'` specifically so `renderOf()` never reaches the
  markdown pipeline either, and this is the only thing standing between mounting and a DOM Monaco
  cannot use under happy-dom.
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

import PageHistoryOverlay from './PageHistoryOverlay.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { openDialogs } from '@/composables/dialog'
import { queue as notifyQueue } from '@/composables/notify'

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
      return { json: () => Promise.resolve([VERSION]) }
    }
    if (String(url).includes('/history/')) {
      return { json: () => Promise.resolve(FULL_VERSION) }
    }
    // -> `pageStore.pageLoad()` (restoreVersion's post-save refresh)
    return { json: () => Promise.resolve({ id: 'page-1' }) }
  })
}

async function mountOverlay() {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  pageStore.$patch({
    id: 'page-1',
    path: 'my-page',
    title: 'My Page',
    locale: 'en',
    editor: 'html'
  })
  siteStore.id = 'site-1'
  userStore.$patch({ permissions: ['write:pages'] })

  mockGetEndpoints()

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(PageHistoryOverlay, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
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
