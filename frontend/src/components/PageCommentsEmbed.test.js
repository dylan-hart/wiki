import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import PageCommentsEmbed from './PageCommentsEmbed.vue'
import { mountWithApp } from '../../test/mount.js'

/*
  Same reasoning as `helpers/commentEmbeds.test.js`: a real <script src> appended by `mount()` is
  exactly what production wants, and happy-dom's test-safe default refuses that load rather than
  silently no-op'ing. `handleDisabledFileLoadingAsSuccess` dispatches `load` instead, which is what
  lets `provider.mount()`'s own `await` resolve in a test.
*/
window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true

const MESSAGES = {
  common: {
    comments: {
      title: 'Comments'
    }
  }
}

const DISQUS_PROVIDER = {
  module: 'disqus',
  title: 'Disqus',
  config: { accountName: 'my-shortname' },
  origin: 'https://wiki.example.com'
}

function mountEmbed({
  commentsProvider = DISQUS_PROVIDER,
  pagePermissions = ['read:comments'],
  pageId = 'p1',
  path = 'en/getting-started'
} = {}) {
  return mountWithApp(PageCommentsEmbed, {
    messages: MESSAGES,
    stores: {
      site: { commentsProvider },
      user: { pagePermissions },
      page: { id: pageId, path }
    }
  })
}

afterEach(() => {
  document.head.innerHTML = ''
})

describe('PageCommentsEmbed', () => {
  it('renders nothing when the reader lacks read:comments', async () => {
    const { wrapper } = mountEmbed({ pagePermissions: [] })
    await flushPromises()

    expect(wrapper.find('.page-comments-embed').exists()).toBe(false)
    expect(document.head.querySelector('script[src*="disqus.com/embed.js"]')).toBeNull()
  })

  it('renders nothing when there is no active codeTemplate provider', async () => {
    const { wrapper } = mountEmbed({ commentsProvider: null })
    await flushPromises()

    expect(wrapper.find('.page-comments-embed').exists()).toBe(false)
  })

  it('mounts the vendor embed and builds the canonical URL from origin + page.path when permitted', async () => {
    const { wrapper } = mountEmbed()
    await flushPromises()

    expect(wrapper.find('.page-comments-embed').exists()).toBe(true)
    expect(wrapper.find('#disqus_thread').exists()).toBe(true)
    const script = document.head.querySelector(
      'script[src="https://my-shortname.disqus.com/embed.js"]'
    )
    expect(script).not.toBeNull()

    const page = {}
    window.disqus_config.call({ page })
    expect(page.url).toBe('https://wiki.example.com/en/getting-started')
  })

  it('never re-derives the origin from window.location -- only siteStore.commentsProvider.origin is used', async () => {
    const { wrapper } = mountEmbed({
      commentsProvider: {
        ...DISQUS_PROVIDER,
        config: { accountName: 'origin-test-shortname' },
        origin: 'https://canonical.example.org'
      }
    })
    await flushPromises()

    expect(wrapper.find('.page-comments-embed').exists()).toBe(true)
    const page = {}
    window.disqus_config.call({ page })
    expect(page.url).toBe('https://canonical.example.org/en/getting-started')
  })

  it('renders nothing for an active provider module this build has no embed builder for', async () => {
    const { wrapper } = mountEmbed({
      commentsProvider: { ...DISQUS_PROVIDER, module: 'unknown-vendor' }
    })
    await flushPromises()

    expect(wrapper.find('.page-comments-embed').exists()).toBe(false)
  })

  it('re-mounts into a fresh container once pageStore.id changes', async () => {
    const { wrapper, pageStore } = mountEmbed({
      commentsProvider: { ...DISQUS_PROVIDER, config: { accountName: 'remount-test-shortname' } }
    })
    await flushPromises()

    const firstContainer = wrapper.find('.page-comments-embed-container').element
    // -> `window.DISQUS` never becomes real under happy-dom's refused-load stand-in (same limitation
    //    documented in `helpers/commentEmbeds.test.js`), so the second mount still goes through the
    //    "load embed.js" branch rather than `DISQUS.reset()` -- what this asserts is the CONTAINER
    //    identity changing, not which of the two branches ran.
    pageStore.id = 'p2'
    pageStore.path = 'en/other-page'
    await flushPromises()

    const secondContainer = wrapper.find('.page-comments-embed-container').element
    expect(secondContainer).not.toBe(firstContainer)
    expect(wrapper.find('#disqus_thread').exists()).toBe(true)
  })
})
