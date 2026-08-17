import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('site store: features.comments default', () => {
  it('defaults to false, so PageComments has something real to gate on before the backend sends it', () => {
    const store = useSiteStore()

    expect(store.features.comments).toBe(false)
  })

  it('applySiteInfo() lets a backend-sent features.comments override the default', () => {
    const store = useSiteStore()
    store.applySiteInfo({
      pageExtensions: [],
      features: { comments: true },
      auth: {},
      editors: {
        asciidoc: { isActive: false },
        markdown: { isActive: true },
        wysiwyg: { isActive: false }
      },
      locales: { active: [] }
    })

    expect(store.features.comments).toBe(true)
  })

  it('applySiteInfo() without a comments key keeps the default rather than going undefined', () => {
    const store = useSiteStore()
    store.applySiteInfo({
      pageExtensions: [],
      features: { ratingsMode: 'stars' },
      auth: {},
      editors: {
        asciidoc: { isActive: false },
        markdown: { isActive: true },
        wysiwyg: { isActive: false }
      },
      locales: { active: [] }
    })

    expect(store.features.comments).toBe(false)
    expect(store.features.ratingsMode).toBe('stars')
  })
})
