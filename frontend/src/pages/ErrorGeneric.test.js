import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import ErrorGeneric from './ErrorGeneric.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2110: `.errorpage-code` / `.errorpage-title` used to be fixed at 12rem/5rem with no
 * media query, clamp() or horizontal padding, so a 403/404 screen overflowed a phone-width viewport
 * with no way to scroll to the clipped half (the content box is absolutely centred and
 * shrink-to-fit). jsdom's CSS engine (`cssstyle`) does not understand `clamp()` -- a declaration
 * using it is silently dropped from `document.styleSheets`, which is why the style rules below are
 * asserted against the component's own source text rather than a parsed/computed stylesheet; the
 * render-time assertions cover that the markup structure carrying those classes still mounts and
 * renders content correctly.
 */

const componentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'ErrorGeneric.vue'),
  'utf8'
)
const styleBlock = componentSource.slice(
  componentSource.indexOf('<style'),
  componentSource.indexOf('</style>')
)

function ruleFor(className) {
  const match = styleBlock.match(new RegExp(`&${className}\\s*\\{([^}]*)\\}`))
  return match?.[1] ?? ''
}

async function mountErrorGeneric(action = 'notfound') {
  const router = await createTestRouter(['/', '/_error/:action'], `/_error/${action}`)

  return mountWithApp(ErrorGeneric, {
    messages: {
      common: {
        error: {
          title: 'Error',
          goHome: 'Go Home',
          loginAs: 'Login',
          notfound: { title: 'Page Not Found', hint: 'The page does not exist' },
          unauthorized: { title: 'Unauthorized', hint: 'You are not authorized' }
        }
      }
    },
    router
  }).wrapper
}

describe('ErrorGeneric responsive type (OpenProject #2110)', () => {
  it('sizes the status code with a viewport-relative clamp(), not a fixed rem value', () => {
    const rule = ruleFor('-code')

    expect(rule).toContain('clamp(')
    expect(rule).toMatch(/clamp\([^)]*vw[^)]*\)/)
  })

  it('sizes the title with a viewport-relative clamp(), not a fixed rem value', () => {
    const rule = ruleFor('-title')

    expect(rule).toContain('clamp(')
    expect(rule).toMatch(/clamp\([^)]*vw[^)]*\)/)
  })

  it('constrains the content box to the viewport width with horizontal padding', () => {
    const rule = ruleFor('-content')

    expect(rule).toMatch(/max-width:\s*100%/)
    expect(rule).toMatch(/padding:\s*0\s+1rem/)
  })

  it('lets the actions row wrap instead of overflowing', () => {
    const rule = ruleFor('-actions')

    expect(rule).toMatch(/flex-wrap:\s*wrap/)
  })

  it('renders the code and title inside the constrained content box', async () => {
    const wrapper = await mountErrorGeneric('notfound')

    const content = wrapper.find('.errorpage-content')
    expect(content.exists()).toBe(true)
    expect(content.find('.errorpage-code').exists()).toBe(true)
    expect(content.find('.errorpage-title').exists()).toBe(true)
    expect(content.text()).toContain('404')
    expect(content.text()).toContain('Page Not Found')
  })
})
