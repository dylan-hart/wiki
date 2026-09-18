import { describe, expect, it } from 'vitest'

import { parseBlockProps, serializeBlockProps } from './wikiBlockAttrs'

describe('wikiBlockAttrs: parseBlockProps()', () => {
  it('reads no props out of an empty/undefined source', () => {
    expect(parseBlockProps('')).toEqual({})
    expect(parseBlockProps(undefined)).toEqual({})
  })

  it('reads a double-quoted value', () => {
    expect(parseBlockProps('label="First tab"')).toEqual({ label: 'First tab' })
  })

  it('reads a single-quoted value', () => {
    expect(parseBlockProps("label='First tab'")).toEqual({ label: 'First tab' })
  })

  it('reads an unquoted value', () => {
    expect(parseBlockProps('active=0')).toEqual({ active: '0' })
  })

  it('reads a bare flag as true', () => {
    expect(parseBlockProps('hideToolbar')).toEqual({ hideToolbar: true })
  })

  it('reads several props, in the order they were written', () => {
    expect(parseBlockProps('label="Second tab" icon="tabler:brand-python" hideToolbar')).toEqual({
      label: 'Second tab',
      icon: 'tabler:brand-python',
      hideToolbar: true
    })
  })
})

describe('wikiBlockAttrs: serializeBlockProps()', () => {
  it('writes nothing for no props', () => {
    expect(serializeBlockProps({})).toBe('')
    expect(serializeBlockProps()).toBe('')
  })

  it('writes a bare flag for true', () => {
    expect(serializeBlockProps({ hideToolbar: true })).toBe('hideToolbar')
  })

  it('writes a quoted value for a string', () => {
    expect(serializeBlockProps({ label: 'First tab' })).toBe('label="First tab"')
  })

  it('turns a double quote inside a value into a single quote, MDC has no escape for it', () => {
    expect(serializeBlockProps({ label: 'Say "hi"' })).toBe(`label="Say 'hi'"`)
  })

  it('drops an empty, null, undefined or false value entirely', () => {
    expect(serializeBlockProps({ a: '', b: null, c: undefined, d: false, kept: '1' })).toBe(
      'kept="1"'
    )
  })

  it('writes several props space-separated, in insertion order', () => {
    expect(serializeBlockProps({ label: 'Second tab', icon: 'tabler:brand-python' })).toBe(
      'label="Second tab" icon="tabler:brand-python"'
    )
  })
})

describe('wikiBlockAttrs: round-trips through parse then serialize', () => {
  it('reproduces an equivalent attribute list', () => {
    const source = 'label="First tab" icon="tabler:brand-python" hideToolbar'
    expect(serializeBlockProps(parseBlockProps(source))).toBe(source)
  })
})
