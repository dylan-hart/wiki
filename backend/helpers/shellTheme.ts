import type { AppShellFragments } from './appShell.ts'

const STYLE_CLOSE_PATTERN = /<\/style/gi
const INJECT_CSS_ELEMENT_ID = 'theme-inject-css'

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * `injectHead` and `injectBody` go in verbatim, behind the same `manage:sites` trust boundary as the
 * client-side application. `injectCSS` is escaped only so it cannot end its own `<style>` element.
 */
export function themeShellFragments(theme: unknown): AppShellFragments {
  const t = (theme ?? {}) as Record<string, unknown>
  const css = nonEmptyString(t.injectCSS)
  const headHtml = nonEmptyString(t.injectHead)
  const bodyHtml = nonEmptyString(t.injectBody)

  const head =
    (css
      ? `<style id="${INJECT_CSS_ELEMENT_ID}">${css.replace(STYLE_CLOSE_PATTERN, () => '<\\/style')}</style>`
      : '') + (headHtml ?? '')

  const fragments: AppShellFragments = {}
  if (head) fragments.head = head
  if (bodyHtml) fragments.bodyEnd = bodyHtml
  return fragments
}
