import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { collectRefs, restyleForCardinal } from './generate-icons.mjs'

describe('restyleForCardinal', () => {
  test('strips the round cap and join, and downweights the stroke', () => {
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v4"/>'

    expect(restyleForCardinal(body)).toBe(
      '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M12 9v4"/>'
    )
  })

  test('leaves a path of real strokes with no linecap at all', () => {
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M11 12h1v4h1"/>'

    expect(restyleForCardinal(body)).not.toContain('stroke-linecap')
  })

  test('gives a path that is nothing but dots its round cap back, in place', () => {
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M12 19v.01"/>'

    expect(restyleForCardinal(body)).toBe(
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M12 19v.01"/>'
    )
  })

  test('splits a mixed path so only the dot is round-capped', () => {
    // -> `tabler:alert-circle`: a ring, the bar of the exclamation mark, then its point
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9-4v4m0 4h.01"/>'

    expect(restyleForCardinal(body)).toBe(
      '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9-4v4"/>' +
        '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M12 16h.01"/>'
    )
  })

  test('resolves a lifted dot to the absolute point its relative moveto meant', () => {
    // -> The dot is written `m9 4v.01`, measured from where the two arcs left off at (3,12); copied
    //    as-is into a path of its own, a leading `m` reads as absolute and it would land at (9,4).
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9 4v.01"/>'

    expect(restyleForCardinal(body)).toContain(
      'stroke-linecap="round" stroke-width="1.5" d="M12 16v.01"'
    )
  })

  test('keeps a dot written before the strokes it shares a path with', () => {
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M15 8h.01M3 6a3 3 0 0 1 3-3h12v12z"/>'
    const restyled = restyleForCardinal(body)

    expect(restyled).toContain('stroke-width="1.5" d="M3 6a3 3 0 0 1 3-3h12v12z"/>')
    expect(restyled).toContain('stroke-linecap="round" stroke-width="1.5" d="M15 8h.01"/>')
  })

  test('round-caps every dot in a path holding several of them', () => {
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M9 6h11M9 12h11M9 18h11M5 6v.01M5 12v.01M5 18v.01"/>'

    expect(restyleForCardinal(body)).toBe(
      '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M9 6h11M9 12h11M9 18h11"/>' +
        '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M5 6v.01M5 12v.01M5 18v.01"/>'
    )
  })

  test('reads a short-but-real segment as a stroke, not a dot', () => {
    // -> `l4 .01` is four units long; only its Y delta is 0.01
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M6 14v.01M10 14l4 .01"/>'
    const restyled = restyleForCardinal(body)

    expect(restyled).toContain('stroke-width="1.5" d="M10 14l4 .01"/>')
    expect(restyled).toContain('stroke-linecap="round" stroke-width="1.5" d="M6 14v.01"/>')
  })

  test('reads a `.01` inside a long segment as a stroke, not a dot', () => {
    // -> `tabler:snowflake` is full of `.01`s that a textual match mistakes for dots
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="m20.66 7l-5.629 3.25l.01 3.458"/>'

    expect(restyleForCardinal(body)).toBe(
      '<path fill="none" stroke="currentColor" stroke-width="1.5" d="m20.66 7l-5.629 3.25l.01 3.458"/>'
    )
  })

  test('reads a curve returning to its own start as a stroke, not a dot', () => {
    const body =
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" d="M12 12c2 0 2 4 0 4"/>'

    expect(restyleForCardinal(body)).not.toContain('stroke-linecap')
  })

  test('reads a bare moveto that draws nothing as neither', () => {
    const body = '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 12"/>'

    expect(restyleForCardinal(body)).not.toContain('stroke-linecap')
  })

  test('leaves a filled path alone, dot idiom or not', () => {
    const body = '<path fill="currentColor" d="M14 19h.01l.11-.006z"/>'

    expect(restyleForCardinal(body)).toBe(body)
  })

  test('caps dots inside a grouped body without disturbing its wrapper', () => {
    const body =
      '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">' +
      '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9-3h.01"/>' +
      '<path d="M11 12h1v4h1"/>' +
      '</g>'

    expect(restyleForCardinal(body)).toBe(
      '<g fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0"/>' +
        '<path stroke-linecap="round" d="M12 9h.01"/>' +
        '<path d="M11 12h1v4h1"/>' +
        '</g>'
    )
  })
})

/**
 * `collectRefs` scans the sibling `blocks/` workspace as well as `frontend/src`: a block's
 * `static definition.icon` is a source literal only there, and reaches `frontend/src` as data.
 */
describe('collectRefs', () => {
  test('finds a literal Iconify reference declared in a block definition', () => {
    const refs = collectRefs()

    expect(refs.has('tabler:topology-star')).toBe(true)
    const sources = refs.get('tabler:topology-star')
    expect(
      sources.some((file) => file === path.join('..', 'blocks/block-kroki/component.js'))
    ).toBe(true)
  })

  test('finds a nested icon in a backend module definition, and not its module-level asset path', () => {
    const refs = collectRefs()

    expect(refs.has('tabler:fingerprint')).toBe(true)
    expect(
      refs
        .get('tabler:fingerprint')
        .some(
          (file) => file === path.join('..', 'backend/modules/authentication/ldap/definition.yml')
        )
    ).toBe(true)
    expect([...refs.keys()].some((ref) => ref.includes('ultraviolet'))).toBe(false)
  })
})
