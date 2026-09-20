import { describe, expect, it } from 'vitest'

import {
  SEARCH_FILTERS_MAX_ROWS,
  appliedFilters,
  defaultFilterValue,
  filtersToSearchParams,
  hasIncludeFilter,
  isFreeTextFilterType,
  newFilterRow,
  restoreFilters,
  toSavedFilters
} from './searchFilters.js'

describe('searchFilters helper', () => {
  it('maps every type and mode to the backend list-valued names', () => {
    const rows = [
      { mode: 'include', type: 'path', value: 'a' },
      { mode: 'exclude', type: 'path', value: 'b' },
      { mode: 'include', type: 'tag', value: 'c' },
      { mode: 'exclude', type: 'tag', value: 'd' },
      { mode: 'include', type: 'locale', value: 'en' },
      { mode: 'exclude', type: 'locale', value: 'fr' },
      { mode: 'include', type: 'editor', value: 'markdown' },
      { mode: 'exclude', type: 'editor', value: 'asciidoc' },
      { mode: 'include', type: 'publishState', value: 'draft' },
      { mode: 'exclude', type: 'publishState', value: 'scheduled' }
    ]

    expect(filtersToSearchParams(rows)).toEqual([
      ['path', 'a'],
      ['excludePath', 'b'],
      ['tags', 'c'],
      ['excludeTags', 'd'],
      ['locales', 'en'],
      ['excludeLocales', 'fr'],
      ['editor', 'markdown'],
      ['excludeEditor', 'asciidoc'],
      ['publishState', 'draft'],
      ['excludePublishState', 'scheduled']
    ])
  })

  it('trims values and strips leading slashes from a path only', () => {
    expect(
      filtersToSearchParams([
        { mode: 'include', type: 'path', value: '  //docs/api ' },
        { mode: 'include', type: 'tag', value: ' /odd ' }
      ])
    ).toEqual([
      ['path', 'docs/api'],
      ['tags', '/odd']
    ])
  })

  it('skips blank, unknown and out-of-enum rows', () => {
    const rows = [
      { mode: 'include', type: 'path', value: '' },
      { mode: 'include', type: 'path', value: '///' },
      { mode: 'maybe', type: 'path', value: 'x' },
      { mode: 'include', type: 'author', value: 'x' },
      { mode: 'include', type: 'publishState', value: 'archived' },
      { mode: 'include', type: 'path', value: 'x'.repeat(513) },
      null,
      { mode: 'include', type: 'tag', value: 'ok' }
    ]

    expect(appliedFilters(rows)).toEqual([{ mode: 'include', type: 'tag', value: 'ok' }])
  })

  it('drops a duplicate pair and folds query tags in without repeating one', () => {
    const rows = [
      { mode: 'include', type: 'tag', value: 'a' },
      { mode: 'include', type: 'tag', value: 'a' }
    ]

    expect(filtersToSearchParams(rows, { queryTags: ['a', 'b'] })).toEqual([
      ['tags', 'a'],
      ['tags', 'b']
    ])
  })

  it('counts an include row, and only an include row, as something to search on', () => {
    expect(hasIncludeFilter([{ mode: 'exclude', type: 'path', value: 'x' }])).toBe(false)
    expect(hasIncludeFilter([{ mode: 'include', type: 'path', value: '' }])).toBe(false)
    expect(hasIncludeFilter([{ mode: 'include', type: 'path', value: 'x' }])).toBe(true)
  })

  it('defaults Locale to the sole locale, Publish State to published, the rest to empty', () => {
    expect(defaultFilterValue('locale', ['en'])).toBe('en')
    expect(defaultFilterValue('locale', ['en', 'fr'])).toBe('')
    expect(defaultFilterValue('locale', [])).toBe('')
    expect(defaultFilterValue('publishState')).toBe('published')
    expect(defaultFilterValue('editor')).toBe('')
    expect(defaultFilterValue('path')).toBe('')
    expect(defaultFilterValue('tag')).toBe('')
  })

  it('starts a new row as Include/Path with no value', () => {
    expect(newFilterRow(['en'])).toEqual({ mode: 'include', type: 'path', value: '' })
  })

  it('treats only path and tag as free-text types', () => {
    expect(['path', 'tag', 'locale', 'editor', 'publishState'].map(isFreeTextFilterType)).toEqual([
      true,
      true,
      false,
      false,
      false
    ])
  })

  it('saves exactly {mode, type, value}, never a UI id, capped at the backend limit', () => {
    const rows = Array.from({ length: SEARCH_FILTERS_MAX_ROWS + 5 }, (_, i) => ({
      id: i,
      mode: 'include',
      type: 'tag',
      value: `t${i}`
    }))

    const saved = toSavedFilters(rows)

    expect(saved).toHaveLength(SEARCH_FILTERS_MAX_ROWS)
    expect(Object.keys(saved[0]).sort()).toEqual(['mode', 'type', 'value'])
  })

  it('restores nothing from a value that is not a list', () => {
    expect(restoreFilters(undefined)).toEqual([])
    expect(restoreFilters({ mode: 'include' })).toEqual([])
  })
})
