import { describe, expect, it } from 'vitest'
import { createPageMentionSuggestion } from './editorMentions.js'

/**
 * Covers `items()`'s branching only; `render()`'s lifecycle is driven against the real
 * `@tiptap/suggestion` plugin in `EditorWysiwyg.test.js`.
 */

describe('createPageMentionSuggestion', () => {
  it('triggers on @ and exposes both an items() source and a render()', () => {
    const suggestion = createPageMentionSuggestion({ id: 'site-1' })

    expect(suggestion.char).toBe('@')
    expect(typeof suggestion.items).toBe('function')
    expect(typeof suggestion.render).toBe('function')
  })

  it('resolves a blank query to no items without making a request', async () => {
    const suggestion = createPageMentionSuggestion({ id: 'site-1' })

    const items = await suggestion.items({ query: '', editor: {}, signal: undefined })

    expect(items).toEqual([])
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('resolves a whitespace-only query to no items without making a request', async () => {
    const suggestion = createPageMentionSuggestion({ id: 'site-1' })

    const items = await suggestion.items({ query: '   ', editor: {}, signal: undefined })

    expect(items).toEqual([])
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it("searches this site's pages for a real query, mapping results to id/label/path/icon", async () => {
    const siteStore = { id: 'site-1' }
    const suggestion = createPageMentionSuggestion(siteStore)
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [
            { path: 'help/faq', title: 'FAQ', icon: 'tabler:help' },
            { path: 'help/guide', title: 'Guide', icon: null }
          ]
        })
    })

    const items = await suggestion.items({ query: 'help', editor: {}, signal: undefined })

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/search', {
      searchParams: { query: 'help', limit: 5 },
      signal: undefined
    })
    expect(items).toEqual([
      { id: 'help/faq', label: 'FAQ', path: 'help/faq', icon: 'tabler:help' },
      { id: 'help/guide', label: 'Guide', path: 'help/guide', icon: null }
    ])
  })

  it('reads the site id lazily, not at creation time', async () => {
    const siteStore = { id: null }
    const suggestion = createPageMentionSuggestion(siteStore)

    expect(await suggestion.items({ query: 'help', editor: {}, signal: undefined })).toEqual([])
    expect(API_CLIENT.get).not.toHaveBeenCalled()

    siteStore.id = 'site-9'
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ results: [] }) })
    await suggestion.items({ query: 'help', editor: {}, signal: undefined })
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-9/pages/search', expect.anything())
  })

  it('resolves an empty result set to no items, distinctly from throwing', async () => {
    const suggestion = createPageMentionSuggestion({ id: 'site-1' })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ results: [] }) })

    await expect(
      suggestion.items({ query: 'zzz-nonexistent', editor: {}, signal: undefined })
    ).resolves.toEqual([])
  })

  it('resolves to no items rather than throwing when the search request fails', async () => {
    const suggestion = createPageMentionSuggestion({ id: 'site-1' })
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })

    await expect(
      suggestion.items({ query: 'help', editor: {}, signal: undefined })
    ).resolves.toEqual([])
  })

  it('resolves to no items when the response has no results field at all', async () => {
    const suggestion = createPageMentionSuggestion({ id: 'site-1' })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(undefined) })

    await expect(
      suggestion.items({ query: 'help', editor: {}, signal: undefined })
    ).resolves.toEqual([])
  })
})
