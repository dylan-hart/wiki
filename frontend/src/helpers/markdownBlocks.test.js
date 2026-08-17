import { describe, expect, it } from 'vitest'

import { blockOpeningLine, blockValues, findBlocks, hasEditableParams } from './markdownBlocks'

describe('findBlocks', () => {
  it('finds an opening line with attributes', () => {
    const [found] = findBlocks('before\n::block-gallery{thumbnailSize=240}\nafter')
    expect(found).toMatchObject({ block: 'gallery', line: 2, fence: '::' })
    expect(found.attributes).toEqual([
      { name: 'thumbnailSize', value: '240', raw: 'thumbnailSize=240' }
    ])
  })

  it('finds a bare opening line with no attributes at all', () => {
    const [found] = findBlocks('::block-index')
    expect(found).toMatchObject({ block: 'index', line: 1 })
    expect(found.attributes).toEqual([])
  })

  it('skips a block-looking line inside a fenced code block -- a code sample, not a block', () => {
    expect(findBlocks('```\n::block-gallery\n```')).toEqual([])
  })

  it('finds a child block of a tabset (e.g. ::block-tab) the same as any other', () => {
    const [outer, inner] = findBlocks(':::block-tabset\n::block-tab{name="One"}\n:::')
    expect(outer).toMatchObject({ block: 'tabset', fence: ':::' })
    expect(inner).toMatchObject({ block: 'tab', fence: '::' })
  })
})

describe('hasEditableParams', () => {
  it('is false for a block this editor holds no definition for', () => {
    expect(hasEditableParams(undefined)).toBe(false)
  })

  it('is false for a definition with an empty props list -- e.g. a tabset child with no switch of its own', () => {
    expect(hasEditableParams({ props: [] })).toBe(false)
  })

  it('is false for a definition with no props key at all', () => {
    expect(hasEditableParams({})).toBe(false)
  })

  it('is true once the definition declares at least one prop', () => {
    expect(hasEditableParams({ props: [{ name: 'thumbnailSize' }] })).toBe(true)
  })
})

describe('blockValues', () => {
  it('reads a written value back for each declared prop', () => {
    const found = findBlocks('::block-gallery{thumbnailSize=240}')[0]
    const definition = { props: [{ name: 'thumbnailSize', type: 'number', default: 120 }] }
    expect(blockValues(found, definition)).toEqual({ thumbnailSize: 240 })
  })

  it('falls back to the prop default when the source says nothing about it', () => {
    const found = findBlocks('::block-gallery')[0]
    const definition = { props: [{ name: 'thumbnailSize', type: 'number', default: 120 }] }
    expect(blockValues(found, definition)).toEqual({ thumbnailSize: 120 })
  })

  it('reads a bare boolean attribute as true', () => {
    const found = findBlocks('::block-gallery{hideToolbar}')[0]
    const definition = { props: [{ name: 'hideToolbar', type: 'boolean', default: false }] }
    expect(blockValues(found, definition)).toEqual({ hideToolbar: true })
  })
})

describe('blockOpeningLine', () => {
  it('round-trips a written value and keeps an attribute the definition does not declare', () => {
    const found = findBlocks('::block-gallery{thumbnailSize=120 .my-class}')[0]
    const definition = { props: [{ name: 'thumbnailSize', type: 'number' }] }
    const line = blockOpeningLine(found, definition, { thumbnailSize: 240 })
    expect(line).toBe('::block-gallery{thumbnailSize="240" .my-class}')
  })
})
