import { describe, expect, it, vi } from 'vitest'
import { useNavSidebarDestination } from './navSidebarDestination'

const mockRoute = { path: '/' }
const mockRouter = { resolve: (to) => ({ path: to }) }

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => mockRouter
}))

/**
 * OpenProject #1360/#2208 (2026-08-24 security audit §3): `destination()`'s fallback branch — for
 * whatever `routableHref` declined as not routable — used to return the author-typed `target`
 * verbatim as `href`, with no scheme check of its own. `javascript:…` parses as a valid `URL` against
 * any base (it just reports back `.protocol === 'javascript:'`), so `routableHref` declining it is not
 * the same as this composable declining it — the fallback has to look at what it got back.
 */
describe('useNavSidebarDestination', () => {
  const { destination } = useNavSidebarDestination()

  it('routes a same-origin path to the SPA router rather than a plain href', () => {
    const result = destination({ target: '/some/page' })
    expect(result.to).toBe('/some/page')
    expect(result.href).toBeUndefined()
  })

  it('yields no href/to at all for a javascript: target — the actual finding', () => {
    const result = destination({ target: 'javascript:alert(1)' })
    expect(result.href).toBeUndefined()
    expect(result.to).toBeUndefined()
  })

  it('yields no href/to for a javascript: target disguised with leading whitespace/newlines', () => {
    const result = destination({ target: 'java\nscript:alert(1)' })
    expect(result.href).toBeUndefined()
    expect(result.to).toBeUndefined()
  })

  it('still opens a plain https:// external link as a plain href', () => {
    const result = destination({ target: 'https://example.com/docs' })
    expect(result.href).toBe('https://example.com/docs')
    expect(result.to).toBeUndefined()
  })

  it('still opens a plain http:// external link as a plain href', () => {
    const result = destination({ target: 'http://example.com/docs' })
    expect(result.href).toBe('http://example.com/docs')
  })

  it('still allows mailto:, per this composable’s own documented intent', () => {
    const result = destination({ target: 'mailto:hello@example.com' })
    expect(result.href).toBe('mailto:hello@example.com')
    expect(result.to).toBeUndefined()
  })

  it('still allows tel:', () => {
    const result = destination({ target: 'tel:+15551234567' })
    expect(result.href).toBe('tel:+15551234567')
  })

  it('refuses data: the same as javascript:', () => {
    const result = destination({ target: 'data:text/html,<script>alert(1)</script>' })
    expect(result.href).toBeUndefined()
    expect(result.to).toBeUndefined()
  })

  it('an item asking for a new tab goes out as a plain href, not routed, even for a same-origin path', () => {
    const result = destination({ target: '/some/page', openInNewWindow: true })
    expect(result.to).toBeUndefined()
    expect(result.href).toBe('/some/page')
    expect(result.target).toBe('_blank')
  })

  it('defaults a missing target to the site root', () => {
    const result = destination({})
    expect(result.to).toBe('/')
  })
})
