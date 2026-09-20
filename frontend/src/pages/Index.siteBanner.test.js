import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useEditorStore } from '@/stores/editor'
import { useSiteStore } from '@/stores/site'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

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
})

async function mountIndex({ banner, editorActive = false } = {}) {
  setActivePinia(createPinia())

  const router = await createTestRouter(['/'])
  const i18n = createTestI18n({})

  const siteStore = useSiteStore()
  if (banner !== undefined) {
    siteStore.banner = banner
  }
  if (editorActive) {
    useEditorStore().$patch({ isActive: true, editor: 'markdown' })
  }

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageToc: true,
        PageTags: true,
        SideDialog: true,
        PageRedirect: true,
        FooterNav: true,
        PageComments: true,
        PageCommentsEmbed: true,
        EditorMarkdown: true,
        EditorWysiwyg: true,
        EditorCode: true,
        EditorAsciidoc: true,
        EditorRedirect: true
      }
    }
  })
  activeWrapper = wrapper

  return { wrapper }
}

describe('Index.vue: site banner', () => {
  it('renders the title and content when enabled', async () => {
    const { wrapper } = await mountIndex({
      banner: { isEnabled: true, title: 'Maintenance', content: 'Down at 9pm.' }
    })

    const banner = wrapper.find('.site-banner')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('Maintenance')
    expect(banner.text()).toContain('Down at 9pm.')
  })

  it('renders content alone without a title element', async () => {
    const { wrapper } = await mountIndex({
      banner: { isEnabled: true, title: '', content: 'Only content' }
    })
    expect(wrapper.find('.site-banner').text()).toBe('Only content')
    expect(wrapper.find('.site-banner-title').exists()).toBe(false)
  })

  it('renders nothing when disabled', async () => {
    const { wrapper } = await mountIndex({
      banner: { isEnabled: false, title: 'Maintenance', content: 'Down at 9pm.' }
    })
    expect(wrapper.find('.site-banner').exists()).toBe(false)
  })

  it('renders nothing when enabled but both title and content are blank', async () => {
    const { wrapper } = await mountIndex({
      banner: { isEnabled: true, title: '  ', content: '' }
    })
    expect(wrapper.find('.site-banner').exists()).toBe(false)
  })

  it('renders nothing when the site carries no banner at all', async () => {
    const { wrapper } = await mountIndex()
    expect(wrapper.find('.site-banner').exists()).toBe(false)
  })

  it('escapes HTML in the content and title, showing them as text', async () => {
    const { wrapper } = await mountIndex({
      banner: {
        isEnabled: true,
        title: '<b>bold</b>',
        content: '<img src=x onerror="alert(1)">'
      }
    })

    const banner = wrapper.find('.site-banner')
    expect(banner.find('img').exists()).toBe(false)
    expect(banner.find('b').exists()).toBe(false)
    expect(banner.text()).toContain('<img src=x onerror="alert(1)">')
    expect(banner.text()).toContain('<b>bold</b>')
  })

  it('preserves line breaks through CSS rather than markup', async () => {
    const { wrapper } = await mountIndex({
      banner: { isEnabled: true, title: '', content: 'one\ntwo' }
    })
    expect(wrapper.find('.site-banner-content').classes()).toContain('whitespace-pre-line')
    expect(wrapper.find('.site-banner br').exists()).toBe(false)
  })

  it('is absent while the editor is active', async () => {
    const { wrapper } = await mountIndex({
      banner: { isEnabled: true, title: 'Maintenance', content: 'Down at 9pm.' },
      editorActive: true
    })
    expect(wrapper.find('.site-banner').exists()).toBe(false)
  })
})
