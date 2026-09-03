import { afterEach, describe, expect, it, vi } from 'vitest'

import { pushEscapeHandler } from './escapeStack'

/**
 * OpenProject #2370: a shared LIFO stack of Escape-consuming popups. See the file's own doc
 * comment for the full reasoning -- these tests cover the stack mechanics directly (push/release,
 * topmost-wins, decline-falls-through), independent of any one component that uses it.
 */

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

function pressOther() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
}

describe('escapeStack', () => {
  const releases = []

  afterEach(() => {
    // -> Undo every push a test made, so a leftover handler cannot fire against a later test's
    //    own Escape dispatch -- the stack is module-level, shared across the whole file.
    while (releases.length) {
      releases.pop()()
    }
  })

  function push(handler) {
    const release = pushEscapeHandler(handler)
    releases.push(release)
    return release
  }

  it('calls the single registered handler on Escape', () => {
    const handler = vi.fn()
    push(handler)

    pressEscape()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores a non-Escape key entirely', () => {
    const handler = vi.fn()
    push(handler)

    pressOther()

    expect(handler).not.toHaveBeenCalled()
  })

  it('calls only the most recently pushed handler when several are registered', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    push(outer)
    push(inner)

    pressEscape()

    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('falls back to the next handler down the stack once the top one releases', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    push(outer)
    const releaseInner = push(inner)

    releaseInner()
    // -> Popped by hand, not via the shared `releases` cleanup above -- remove it there too so
    //    afterEach doesn't try to release it a second time.
    releases.pop()

    pressEscape()

    expect(inner).not.toHaveBeenCalled()
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('falls through to the next handler when the topmost one declines (returns false)', () => {
    const outer = vi.fn()
    const decliningInner = vi.fn(() => false)
    push(outer)
    push(decliningInner)

    pressEscape()

    expect(decliningInner).toHaveBeenCalledTimes(1)
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the only handler declines and nothing is underneath it', () => {
    const decliningOnly = vi.fn(() => false)
    push(decliningOnly)

    expect(() => pressEscape()).not.toThrow()
    expect(decliningOnly).toHaveBeenCalledTimes(1)
  })

  it('a released handler is skipped even if pushed again earlier in the stack', () => {
    const handler = vi.fn()
    const release = push(handler)

    release()
    releases.pop()

    pressEscape()

    expect(handler).not.toHaveBeenCalled()
  })

  it('does nothing when the stack is empty', () => {
    expect(() => pressEscape()).not.toThrow()
  })
})
