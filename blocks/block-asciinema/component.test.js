import { afterEach, describe, expect, it, vi } from 'vitest'

import { mountBlock, resetBlockDom } from '../test/mount.js'

/*
  `create()` from `asciinema-player` builds a real terminal renderer -- canvas 2D context, a
  ResizeObserver -- neither of which jsdom implements, so it throws outright in this environment
  (confirmed directly: `2D ctx not available` / `ResizeObserver is not defined`). Mocked here rather
  than worked around, the same way a heavy third-party renderer is usually kept out of a unit test's
  own environment gaps.
*/
const createMock = vi.fn(() => ({ dispose: vi.fn() }))
vi.mock('asciinema-player', () => ({ create: createMock }))

const { BlockAsciinemaElement } = await import('./component.js')

const mountAsciinema = (props = {}) => mountBlock('block-asciinema', { props })

describe('block-asciinema', () => {
  afterEach(() => {
    resetBlockDom()
    createMock.mockClear()
  })

  it('registers itself as a custom element', () => {
    expect(customElements.get('block-asciinema')).toBe(BlockAsciinemaElement)
  })

  it('shows an error and never creates a player when src is empty', async () => {
    const el = await mountAsciinema({ src: '' })

    expect(el.shadowRoot.querySelector('.error').textContent).toContain(
      'needs the address of a .cast recording'
    )
    expect(createMock).not.toHaveBeenCalled()
  })

  it('creates the player against the .player container once mounted', async () => {
    const el = await mountAsciinema({ src: '/recording.cast' })

    expect(createMock).toHaveBeenCalledTimes(1)
    const [, container] = createMock.mock.calls[0]
    expect(container).toBe(el.shadowRoot.querySelector('.player'))
  })

  it('passes only the options that were actually set, defaulting theme and fit', async () => {
    await mountAsciinema({ src: '/recording.cast' })

    const [, , options] = createMock.mock.calls[0]
    expect(options).toEqual({
      theme: 'asciinema',
      autoPlay: false,
      loop: false,
      speed: 1,
      fit: 'width'
    })
    expect(options.idleTimeLimit).toBeUndefined()
  })

  it('clamps a speed above 10, and falls back to 1 for a non-positive one', async () => {
    const fast = await mountAsciinema({ src: '/recording.cast', speed: 50 })
    expect(createMock.mock.calls[0][2].speed).toBe(10)
    createMock.mockClear()

    await mountAsciinema({ src: '/recording.cast', speed: -3 })
    expect(createMock.mock.calls[0][2].speed).toBe(1)
    fast.remove()
  })

  it('includes idleTimeLimit only when a positive number was given', async () => {
    await mountAsciinema({ src: '/recording.cast', idleTimeLimit: 5 })
    expect(createMock.mock.calls[0][2].idleTimeLimit).toBe(5)
    createMock.mockClear()

    await mountAsciinema({ src: '/recording.cast', idleTimeLimit: -1 })
    expect(createMock.mock.calls[0][2]).not.toHaveProperty('idleTimeLimit')
  })

  it('disposes the player on disconnect', async () => {
    const el = await mountAsciinema({ src: '/recording.cast' })
    const player = createMock.mock.results[0].value

    el.remove()

    expect(player.dispose).toHaveBeenCalled()
  })
})
