import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * `pageSaveFlow.js`'s `saveChangesCommit` patches `pageStore.render` a tick BEFORE
 * `editorStore.isActive` flips to `false`, so `Index.vue`'s enhance watcher fires while the reading
 * branch -- and its `pageContents` template ref -- is still unmounted, and nothing re-triggers it
 * once that DOM mounts. Driven straight against the stores: the save flow has its own coverage.
 */

const STUBS = {
  PageHeader: true,
  PageActionsCol: true,
  PageToc: true,
  PageTags: true,
  SideDialog: true,
  PageRedirect: true,
  FooterNav: true,
  PageComments: true,
  PageCommentsEmbed: true
}

const MESSAGES = {
  common: {
    renderedContent: {
      copyCode: 'Copy code',
      copyCodeDone: 'Copied!'
    }
  }
}

const CODE_BLOCK_HTML = '<pre class="codeblock"><code>const a = 1</code></pre>'

beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))

  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  }
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  vi.restoreAllMocks()
})

async function mountAt(initialPath) {
  setActivePinia(createPinia())
  const router = await createTestRouter(['/:pathMatch(.*)*'], initialPath)
  const i18n = createTestI18n(MESSAGES)

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: STUBS
    }
  })
  activeWrapper = wrapper

  return { wrapper, editorStore: useEditorStore(), pageStore: usePageStore() }
}

describe('Index.vue: code-copy button appears after edit-and-save (OpenProject #3061)', () => {
  it('renders the copy button once the editor closes, even though the render changed one tick earlier while it was still open', async () => {
    const { wrapper, editorStore, pageStore } = await mountAt('/some-page')
    await flushPromises()

    editorStore.$patch({ isActive: true, editor: 'markdown' })
    pageStore.$patch({ notFound: false, isLocked: false, editor: '' })
    await flushPromises()

    expect(wrapper.find('pre.codeblock button.code-copy').exists()).toBe(false)

    pageStore.$patch({ render: CODE_BLOCK_HTML })
    await flushPromises()

    expect(wrapper.find('.page-contents').exists()).toBe(false)
    expect(wrapper.find('pre.codeblock').exists()).toBe(false)

    editorStore.$patch({ isActive: false, editor: '' })
    await flushPromises()

    const pre = wrapper.find('pre.codeblock')
    expect(pre.exists()).toBe(true)
    expect(pre.find('button.code-copy').exists()).toBe(true)
  })

  it('does not throw, and adds no button, when the editor closes onto a locked page instead of the reading view', async () => {
    const { wrapper, editorStore, pageStore } = await mountAt('/some-page')
    await flushPromises()

    editorStore.$patch({ isActive: true, editor: 'markdown' })
    pageStore.$patch({ notFound: false, isLocked: false, editor: '', render: CODE_BLOCK_HTML })
    await flushPromises()

    pageStore.$patch({ isLocked: true })
    editorStore.$patch({ isActive: false, editor: '' })
    await flushPromises()

    expect(wrapper.find('.page-contents').exists()).toBe(false)
    expect(wrapper.find('.page-placeholder').exists()).toBe(true)
  })
})
