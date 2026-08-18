import { describe, expect, it } from 'vitest'

import { blockOpeningLine, blockValues, findBlocks } from './markdownBlocks.js'

/**
 * `blockValues` is what the "Edit Block Parameters" lens opens the form on: a prop the page's source
 * says nothing about falls back to what the block would do if left alone. For a block whose admin
 * card offers a site-wide default (`config`, e.g. block-kroki/block-plantuml's "Server" field), that
 * fallback should be the site's configured value rather than the component's own hardcoded default —
 * an admin who has set one gets to see it reflected back, not silently overridden.
 */

const DEFINITION = {
  props: [
    { name: 'server', type: 'string', default: 'https://kroki.io' },
    { name: 'format', type: 'select', options: ['svg', 'png'], default: 'svg' }
  ]
}

describe('blockValues', () => {
  it('falls back to the prop default when the block has no site config', () => {
    const found = { attributes: [] }
    expect(blockValues(found, DEFINITION)).toEqual({ server: 'https://kroki.io', format: 'svg' })
  })

  it('falls back to the site config value over the prop default when the page omits the prop', () => {
    const found = { attributes: [] }
    const definition = { ...DEFINITION, config: { server: 'https://kroki.example.com' } }
    expect(blockValues(found, definition)).toEqual({
      server: 'https://kroki.example.com',
      format: 'svg'
    })
  })

  it('still prefers what the page itself wrote over both the site config and the prop default', () => {
    const found = { attributes: [{ name: 'server', value: 'https://from-the-page.example.com' }] }
    const definition = { ...DEFINITION, config: { server: 'https://kroki.example.com' } }
    expect(blockValues(found, definition)).toEqual({
      server: 'https://from-the-page.example.com',
      format: 'svg'
    })
  })

  it('ignores an empty-string site config value, falling back to the prop default', () => {
    const found = { attributes: [] }
    const definition = { ...DEFINITION, config: { server: '' } }
    expect(blockValues(found, definition)).toEqual({ server: 'https://kroki.io', format: 'svg' })
  })

  /*
    None of the three diagram blocks declare a `boolean` prop themselves, but `blockValues()`'s type
    switch is shared by every block the picker knows about, and a bare MDC attribute (no `="value"`
    at all) is exactly how a boolean prop is written when true — `{ hideToolbar }`, not
    `{ hideToolbar="true" }`. Covering the switch directly, rather than only through blocks that
    happen not to exercise this branch, is what the task asks for.
  */
  const BOOLEAN_DEFINITION = { props: [{ name: 'hideToolbar', type: 'boolean', default: false }] }

  it('reads a bare boolean attribute (no value at all) as true', () => {
    const found = { attributes: [{ name: 'hideToolbar', value: null }] }
    expect(blockValues(found, BOOLEAN_DEFINITION)).toEqual({ hideToolbar: true })
  })

  it('reads an explicit "false" boolean attribute as false', () => {
    const found = { attributes: [{ name: 'hideToolbar', value: 'false' }] }
    expect(blockValues(found, BOOLEAN_DEFINITION)).toEqual({ hideToolbar: false })
  })

  it('reads any other written value of a boolean attribute as true', () => {
    const found = { attributes: [{ name: 'hideToolbar', value: 'yes' }] }
    expect(blockValues(found, BOOLEAN_DEFINITION)).toEqual({ hideToolbar: true })
  })
})

/**
 * Round-trip coverage of the "Edit Block Parameters" lens for the three diagram blocks specifically:
 * `findBlocks` reading a real opening line back out of page source, `blockValues` coercing it into
 * form state, and `blockOpeningLine` writing the edited form back out — including that an attribute
 * the block's own definition does not declare (`kept`, e.g. one written by an older version of the
 * block, or a stray `.class`) survives a re-save untouched rather than being silently dropped.
 */
describe('the diagram blocks round-trip through findBlocks / blockValues / blockOpeningLine', () => {
  const DIAGRAM = {
    block: 'diagram',
    props: [
      { name: 'caption', type: 'string' },
      {
        name: 'theme',
        type: 'select',
        options: ['auto', 'default', 'dark', 'neutral', 'forest'],
        default: 'auto'
      },
      { name: 'align', type: 'select', options: ['left', 'center'], default: 'left' }
    ]
  }

  const KROKI = {
    block: 'kroki',
    props: [
      { name: 'type', type: 'select', default: 'graphviz' },
      { name: 'server', type: 'string', default: 'https://kroki.io' },
      { name: 'format', type: 'select', options: ['svg', 'png'], default: 'svg' },
      { name: 'caption', type: 'string' },
      { name: 'align', type: 'select', options: ['left', 'center'], default: 'left' }
    ]
  }

  const PLANTUML = {
    block: 'plantuml',
    props: [
      { name: 'server', type: 'string', default: 'https://www.plantuml.com/plantuml' },
      { name: 'format', type: 'select', options: ['svg', 'png'], default: 'svg' },
      { name: 'caption', type: 'string' },
      { name: 'align', type: 'select', options: ['left', 'center'], default: 'left' }
    ]
  }

  it("round-trips block-diagram's theme/align/caption", () => {
    const source = [
      'Some intro text.',
      '',
      '::block-diagram{caption="Ship flow" theme="dark" align="center"}',
      '::',
      '',
      'More text.'
    ].join('\n')

    const [found] = findBlocks(source)
    expect(found).toMatchObject({ block: 'diagram', line: 3, fence: '::' })

    const values = blockValues(found, DIAGRAM)
    expect(values).toEqual({ caption: 'Ship flow', theme: 'dark', align: 'center' })

    // -> The author edits the alignment back to the default and leaves the rest
    const edited = { ...values, align: 'left' }
    // -> align="left" is the prop's own default, so `blockAttributes` leaves it out entirely
    expect(blockOpeningLine(found, DIAGRAM, edited)).toBe(
      '::block-diagram{caption="Ship flow" theme="dark"}'
    )
  })

  it("round-trips block-kroki's type/server/format/caption/align, keeping an attribute the block doesn't declare", () => {
    const source = [
      '::block-kroki{type="d2" server="https://kroki.example.com" format="png" caption="Topology" align="center" data-legacy="x"}',
      'digraph G { a -> b }',
      '::'
    ].join('\n')

    const [found] = findBlocks(source)
    const values = blockValues(found, KROKI)
    expect(values).toEqual({
      type: 'd2',
      server: 'https://kroki.example.com',
      format: 'png',
      caption: 'Topology',
      align: 'center'
    })

    // -> Only `format` changes; `data-legacy` is not one of this block's props, so it must be kept
    const edited = { ...values, format: 'svg' }
    expect(blockOpeningLine(found, KROKI, edited)).toBe(
      '::block-kroki{type="d2" server="https://kroki.example.com" caption="Topology" align="center" data-legacy="x"}'
    )
  })

  it("round-trips block-plantuml's server/format/caption/align", () => {
    const source = [
      '::block-plantuml{server="https://plantuml.example.com" format="png" caption="Sequence" align="center"}',
      '@startuml',
      'Alice -> Bob : hi',
      '@enduml',
      '::'
    ].join('\n')

    const [found] = findBlocks(source)
    expect(found.fence).toBe('::')

    const values = blockValues(found, PLANTUML)
    expect(values).toEqual({
      server: 'https://plantuml.example.com',
      format: 'png',
      caption: 'Sequence',
      align: 'center'
    })

    // -> Every value unchanged: re-saving without editing anything must reproduce the same line
    expect(blockOpeningLine(found, PLANTUML, values)).toBe(
      '::block-plantuml{server="https://plantuml.example.com" format="png" caption="Sequence" align="center"}'
    )
  })

  it("falls back to each block's own defaults for a page that wrote no attributes at all", () => {
    const source = '::block-diagram\n::'
    const [found] = findBlocks(source)
    expect(blockValues(found, DIAGRAM)).toEqual({ caption: '', theme: 'auto', align: 'left' })
    // -> Nothing to write: every value equals its own default, so the line comes back bare
    expect(blockOpeningLine(found, DIAGRAM, blockValues(found, DIAGRAM))).toBe('::block-diagram')
  })
})
