import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enhanceRenderedContent, routableHref, sameDocumentHash } from './renderedContent'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * OpenProject #1597: the clipboard-failure toast this file's copy controls raise (code-block copy,
 * heading-anchor copy) used to hardcode English rather than going through `t()`. Coverage here is
 * scoped to that localization -- the copy controls' DOM/interaction behavior otherwise is
 * pre-existing and untouched by that change.
 */

// A translation table standing in for `en.json`, keyed the same way a real `useI18n().t` would
// resolve them -- proof that `enhanceRenderedContent` actually threads its `t` argument through to
// the notify() call, not just that some string appears.
const MESSAGES = {
  'common.clipboard.failure': 'Failed to copy to clipboard.'
}
const t = (key) => MESSAGES[key] ?? key

function codeBlock(text) {
  const pre = document.createElement('pre')
  pre.className = 'codeblock'
  const code = document.createElement('code')
  code.textContent = text
  pre.appendChild(code)
  document.body.appendChild(pre)
  return pre
}

describe('renderedContent clipboard localization', () => {
  beforeEach(() => {
    notifyQueue.length = 0
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('raises the localized failure message via the passed-in t() when the copy rejects', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)

    const button = pre.querySelector('.code-copy')
    expect(button).not.toBeNull()

    button.click()
    // -> copyWithFeedback's catch runs after the rejected clipboard promise settles
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(notifyQueue).toHaveLength(1)
    expect(notifyQueue[0].type).toBe('negative')
    expect(notifyQueue[0].message).toBe('Failed to copy to clipboard.')
    expect(notifyQueue[0].caption).toBe('denied')
  })

  it('raises nothing when the copy succeeds', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)

    pre.querySelector('.code-copy').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(notifyQueue).toHaveLength(0)
  })

  it('is idempotent -- re-running over the same content adds no second button', () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn() } })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)
    enhanceRenderedContent(pre.parentNode, t)

    expect(pre.querySelectorAll('.code-copy')).toHaveLength(1)
  })
})

describe('routableHref / sameDocumentHash (unchanged by #1597, smoke-tested alongside the file)', () => {
  const current = { origin: 'https://wiki.example.com', pathname: '/en/home' }

  it('routes a same-origin link to a different page', () => {
    expect(routableHref({ href: 'https://wiki.example.com/en/other' }, current)).toBe('/en/other')
  })

  it('declines a cross-origin link', () => {
    expect(routableHref({ href: 'https://elsewhere.example.com/en/other' }, current)).toBeNull()
  })

  it('resolves a same-page fragment as a hash to scroll to, not a route', () => {
    expect(routableHref({ href: 'https://wiki.example.com/en/home#section' }, current)).toBeNull()
    expect(sameDocumentHash({ href: 'https://wiki.example.com/en/home#section' }, current)).toBe(
      '#section'
    )
  })
})
