import { describe, expect, it } from 'vitest'

import { directionalAnchor } from './directionalAnchor.js'

describe('directionalAnchor', () => {
  it('leaves an LTR anchor/self pair untouched under ltr', () => {
    expect(directionalAnchor('ltr', 'center right', 'center left')).toEqual({
      anchor: 'center right',
      self: 'center left'
    })
  })

  it('mirrors left/right in both anchor and self under rtl', () => {
    expect(directionalAnchor('rtl', 'center right', 'center left')).toEqual({
      anchor: 'center left',
      self: 'center right'
    })
  })

  it('mirrors a "<vertical> <horizontal>" pair, keeping the vertical word as-is', () => {
    expect(directionalAnchor('rtl', 'top right', 'top left')).toEqual({
      anchor: 'top left',
      self: 'top right'
    })
  })

  it('leaves a middle/center anchor alone in either direction, since there is nothing to mirror', () => {
    expect(directionalAnchor('ltr', 'bottom middle', 'top middle')).toEqual({
      anchor: 'bottom middle',
      self: 'top middle'
    })
    expect(directionalAnchor('rtl', 'bottom middle', 'top middle')).toEqual({
      anchor: 'bottom middle',
      self: 'top middle'
    })
  })
})
