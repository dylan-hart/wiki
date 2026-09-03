import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

import { useNavSidebarDestination } from './navSidebarDestination'
import routes from '@/router/routes'

import { createTestRouter } from '../../test/router.js'

/**
 * A focused unit test of `destination()` alone, alongside the fuller case matrix
 * `components/NavSidebar.test.js` runs through the actual rendered component -- see that file for
 * every category `routableHref` and the protocol allowlist here sort a nav item's `target` into.
 * OpenProject #1360/#2208 §3, 2026-08-24 security audit: a `javascript:` (or `data:`) target used to
 * be handed straight to `<w-item>`'s `href` binding, which Vue does not sanitize -- `javascript:…`
 * parses as a valid `URL` against any base (it just reports back `.protocol === 'javascript:'`), so
 * `routableHref` declining it is not the same as this composable declining it: the fallback has to
 * look at what it got back, not just that something parsed.
 */
async function mountDestination() {
  let captured
  const Host = defineComponent({
    setup() {
      captured = useNavSidebarDestination()
      return () => h('div')
    }
  })

  const router = await createTestRouter(routes)

  mount(Host, { global: { plugins: [router] } })
  return captured
}

describe('useNavSidebarDestination#destination', () => {
  it('refuses a javascript: target -- neither to nor href', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'javascript:alert(1)' })).toEqual({})
  })

  it('refuses a javascript: target disguised behind a line-comment (the naive-regex bypass)', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'javascript://%0aalert(1)' })).toEqual({})
  })

  it('refuses a javascript: target disguised with leading whitespace/newlines', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: 'java\nscript:alert(1)' })
    expect(result.href).toBeUndefined()
    expect(result.to).toBeUndefined()
  })

  it('refuses a data: target', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'data:text/html,<script>alert(1)</script>' })).toEqual({})
  })

  it('still routes a same-origin rooted target', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: '/some/page' })).toEqual({ to: '/some/page' })
  })

  it('still routes an absolute https:// target as a plain link', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'https://example.org/x' })).toEqual({
      href: 'https://example.org/x',
      target: undefined
    })
  })

  it('still opens a plain http:// external link as a plain href', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: 'http://example.com/docs' })
    expect(result.href).toBe('http://example.com/docs')
  })

  it('still hands out a mailto: target as a plain href', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'mailto:hello@example.org' })).toEqual({
      href: 'mailto:hello@example.org',
      target: undefined
    })
  })

  it('still allows tel:', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: 'tel:+15551234567' })
    expect(result.href).toBe('tel:+15551234567')
  })

  it('defaults a missing target to the site root', async () => {
    const { destination } = await mountDestination()
    const result = destination({})
    expect(result.to).toBe('/')
  })

  it('an item asking for a new tab goes out as a plain href, not routed, even for a same-origin path', async () => {
    const { destination } = await mountDestination()
    const result = destination({ target: '/some/page', openInNewWindow: true })
    expect(result.to).toBeUndefined()
    expect(result.href).toBe('/some/page')
    expect(result.target).toBe('_blank')
  })

  it('respects openInNewWindow for a refused target too -- still no href, still no to', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'javascript:alert(1)', openInNewWindow: true })).toEqual({})
  })
})
