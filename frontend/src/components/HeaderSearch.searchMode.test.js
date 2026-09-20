import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import HeaderSearch from './HeaderSearch.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * The toggle only flips a local pending mode: navigation to `/_search`, carrying it as `?mode=`,
 * happens on submit -- Enter, or a toggle click made while a query is already typed.
 */

async function mountWithSemantic({ semanticSearch = true, initialPath = '/', search = '' } = {}) {
  const router = await createTestRouter(['/', '/_search'], initialPath)

  const { wrapper, siteStore } = mountWithApp(HeaderSearch, {
    router,
    stores: {
      site: (store) => {
        store.features.search = true
        store.features.semanticSearch = semanticSearch
        store.search = search
      }
    }
  })

  return { wrapper, router, siteStore }
}

describe('HeaderSearch semantic-search mode toggle (OpenProject #3138)', () => {
  it('is absent when the site has no semantic search available', async () => {
    const { wrapper } = await mountWithSemantic({ semanticSearch: false })

    expect(wrapper.find('.header-search-mode-btn').exists()).toBe(false)
  })

  it('renders using tabler:sparkles, immediately to the left of the Browse by Tags button, when available', async () => {
    const { wrapper } = await mountWithSemantic()

    const modeBtn = wrapper.find('.header-search-mode-btn')
    expect(modeBtn.exists()).toBe(true)
    expect(modeBtn.find('[data-icon]').attributes('data-icon')).toBe('tabler:sparkles')

    const row = wrapper.find('.header-search-row-inline').element
    const modeIndex = row.innerHTML.indexOf('header-search-mode-btn')
    const tagsIndex = row.innerHTML.indexOf('header-search-tags-btn')
    expect(modeIndex).toBeGreaterThan(-1)
    expect(tagsIndex).toBeGreaterThan(modeIndex)
  })

  it('does not render in row (phone) form even when semantic search is available', async () => {
    const router = await createTestRouter(['/'])
    const { wrapper } = mountWithApp(HeaderSearch, {
      props: { row: true },
      router,
      stores: {
        site: (store) => {
          store.features.search = true
          store.features.semanticSearch = true
        }
      }
    })

    expect(wrapper.find('.header-search-mode-btn').exists()).toBe(false)
  })

  it('starts unpressed, in Keyword mode', async () => {
    const { wrapper } = await mountWithSemantic()

    const modeBtn = wrapper.find('.header-search-mode-btn')
    expect(modeBtn.attributes('aria-pressed')).toBe('false')
    expect(modeBtn.classes()).not.toContain('is-active')
  })

  it('toggles to Semantic (aria-pressed + is-active) on click, without navigating when no query is typed', async () => {
    const { wrapper, router } = await mountWithSemantic()
    const pushSpy = vi.spyOn(router, 'push')
    const replaceSpy = vi.spyOn(router, 'replace')

    await wrapper.find('.header-search-mode-btn').trigger('click')

    const modeBtn = wrapper.find('.header-search-mode-btn')
    expect(modeBtn.attributes('aria-pressed')).toBe('true')
    expect(modeBtn.classes()).toContain('is-active')
    expect(pushSpy).not.toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('toggles back to Keyword on a second click', async () => {
    const { wrapper } = await mountWithSemantic()

    const modeBtn = wrapper.find('.header-search-mode-btn')
    await modeBtn.trigger('click')
    await modeBtn.trigger('click')

    expect(modeBtn.attributes('aria-pressed')).toBe('false')
    expect(modeBtn.classes()).not.toContain('is-active')
  })

  it('immediately resubmits (push) under the new mode when a query is already typed', async () => {
    const { wrapper, router } = await mountWithSemantic({ search: 'hello' })
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.header-search-mode-btn').trigger('click')
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith({
      path: '/_search',
      query: { q: 'hello', mode: 'semantic' }
    })
  })

  it('resubmits with replace, not push, when a results page is already open', async () => {
    const { wrapper, router } = await mountWithSemantic({
      initialPath: '/_search',
      search: 'hello'
    })
    const replaceSpy = vi.spyOn(router, 'replace')
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.header-search-mode-btn').trigger('click')
    await flushPromises()

    expect(replaceSpy).toHaveBeenCalledWith({
      path: '/_search',
      query: { q: 'hello', mode: 'semantic' }
    })
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('carries the pending mode on Enter, not just on a toggle click', async () => {
    const { wrapper, router } = await mountWithSemantic()
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.header-search-mode-btn').trigger('click')
    await wrapper.find('.header-search-input').setValue('hello')
    await wrapper.find('.header-search-input').trigger('keyup.enter')
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith({
      path: '/_search',
      query: { q: 'hello', mode: 'semantic' }
    })
  })

  it('carries mode: keyword on Enter when the toggle was never pressed', async () => {
    const { wrapper, router } = await mountWithSemantic()
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.header-search-input').setValue('hello')
    await wrapper.find('.header-search-input').trigger('keyup.enter')
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith({
      path: '/_search',
      query: { q: 'hello', mode: 'keyword' }
    })
  })
})
