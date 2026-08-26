import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import { useNavSidebarDestination } from './navSidebarDestination'
import routes from '@/router/routes'

/**
 * A focused unit test of `destination()` alone, alongside the fuller case matrix
 * `components/NavSidebar.test.js` runs through the actual rendered component -- see that file for
 * every category `routableHref` and the protocol allowlist here sort a nav item's `target` into.
 * OpenProject #2208 §3: a `javascript:` (or `data:`) target used to be handed straight to `<w-item>`'s
 * `href` binding, which Vue does not sanitize.
 */
async function mountDestination() {
  let captured
  const Host = defineComponent({
    setup() {
      captured = useNavSidebarDestination()
      return () => h('div')
    }
  })

  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push('/')
  await router.isReady()

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

  it('still hands out a mailto: target as a plain href', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'mailto:hello@example.org' })).toEqual({
      href: 'mailto:hello@example.org',
      target: undefined
    })
  })

  it('respects openInNewWindow for a refused target too -- still no href, still no to', async () => {
    const { destination } = await mountDestination()
    expect(destination({ target: 'javascript:alert(1)', openInNewWindow: true })).toEqual({})
  })
})
