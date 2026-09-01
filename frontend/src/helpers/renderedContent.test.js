import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enhanceRenderedContent, routableHref, sameDocumentHash } from './renderedContent'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * OpenProject #1597: the clipboard-failure toast this file's copy controls raise (code-block copy,
 * heading-anchor copy) used to hardcode English rather than going through `t()`. OpenProject #2357:
 * the four accessible-name/tooltip strings on those same controls ('Copy code', 'Copied', 'Copy link
 * to this section', 'Link copied') were left hardcoded in that same edit -- coverage here also
 * proves those four now resolve through the passed-in `t`. The copy controls' DOM/interaction
 * behavior otherwise is pre-existing and untouched by either change.
 */

// A translation table standing in for `en.json`, keyed the same way a real `useI18n().t` would
// resolve them -- proof that `enhanceRenderedContent` actually threads its `t` argument through to
// the notify() call and the controls' labels, not just that some string appears.
const MESSAGES = {
  'common.clipboard.failure': 'Failed to copy to clipboard.',
  'common.renderedContent.copyCode': 'Copy code',
  'common.renderedContent.copyCodeDone': 'Copied',
  'common.renderedContent.copyHeadingLink': 'Copy link to this section',
  'common.renderedContent.copyHeadingLinkDone': 'Link copied'
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

function headingWithId(id) {
  const heading = document.createElement('h2')
  heading.id = id
  heading.textContent = 'A section'
  document.body.appendChild(heading)
  return heading
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

/**
 * OpenProject #2357: the code-copy and heading-anchor buttons' accessible name (and, for the
 * heading anchor, its tooltip) come from the same `t()` passed into `enhanceRenderedContent` --
 * both at initial paint and after a successful copy flips the control into its "done" state.
 */
describe('renderedContent accessible-name/tooltip localization (#2357)', () => {
  beforeEach(() => {
    notifyQueue.length = 0
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('labels the code-copy button via t() at creation, and via t() again once copied', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })

    const pre = codeBlock('console.log(1)')
    enhanceRenderedContent(pre.parentNode, t)

    const button = pre.querySelector('.code-copy')
    expect(button.getAttribute('aria-label')).toBe('Copy code')
    expect(button.dataset.tooltip).toBeUndefined()

    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(button.getAttribute('aria-label')).toBe('Copied')
  })

  it('labels the heading-anchor button (aria-label and tooltip) via t() at creation, and via t() again once copied', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })

    const heading = headingWithId('a-section')
    enhanceRenderedContent(heading.parentNode, t)

    const button = heading.querySelector('.heading-anchor')
    expect(button.getAttribute('aria-label')).toBe('Copy link to this section')
    expect(button.dataset.tooltip).toBe('Copy link to this section')

    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(button.getAttribute('aria-label')).toBe('Link copied')
    expect(button.dataset.tooltip).toBe('Link copied')
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
