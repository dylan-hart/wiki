/**
 * Server-side templating for the compiled SPA shell (`assets/index.html`).
 *
 * The bundle is otherwise static -- Vite writes it once at build time -- so `lang`/`dir` on `<html>`
 * are whatever `frontend/index.html` hardcoded (`lang="en"`, no `dir`). The client corrects both
 * itself (`App.vue`'s `applyLocale`), but only once its JS has loaded, parsed and run: for every byte
 * between first paint and that point, a reader on an RTL locale sees an LTR document. This function
 * closes that window by rewriting the two attributes into the HTML before it is ever sent, using the
 * same site/locale resolution `index.ts` already does per-request for other purposes.
 *
 * Deliberately narrow: only `lang` and `dir` are templated. A dark-mode class on `<body>` is
 * possible too (`useDark` in `frontend/src/composables/dark.js` already seeds itself from the DOM
 * for exactly this reason), but that depends on which theme a *signed-in user* chose, not just the
 * site's default -- resolving that server-side needs a session/cookie read this task did not need in
 * order to fix the RTL FOUC, so it was left out rather than guessed at.
 */

import type { LocaleRoutingConfig } from './common.ts'
import { matchLocaleCode, stripLocalePrefix } from './common.ts'

const HTML_TAG_PATTERN = /<html\b[^>]*>/i

export interface AppShellTemplateOptions {
  /** The site's primary locale code, e.g. `en`. */
  lang: string
  /** Whether that locale reads right-to-left. */
  isRTL: boolean
}

/**
 * Rewrites the `<html>` tag of the compiled app shell to carry the requesting site's primary locale
 * and text direction, so first paint already matches what `App.vue` would otherwise set moments later.
 *
 * Matches the opening `<html ...>` tag however it happens to be attributed rather than assuming the
 * exact literal string `frontend/index.html` ships today, so a template rebuild that adds another
 * attribute there doesn't silently stop being rewritten. If no `<html>` tag is found at all, the
 * document is returned unchanged rather than throwing -- templating is an enhancement, never a
 * reason to fail serving the shell.
 */
export function templateAppShell(html: string, { lang, isRTL }: AppShellTemplateOptions): string {
  if (!HTML_TAG_PATTERN.test(html)) {
    return html
  }
  return html.replace(HTML_TAG_PATTERN, `<html lang="${lang}" dir="${isRTL ? 'rtl' : 'ltr'}">`)
}

/**
 * The locale the app shell should be stamped with (`<html lang dir>`) for one request — the same
 * resolution the frontend's `resolveRouteLocale` performs once booted, done server-side so an RTL
 * translation never flashes LTR (the exact flash the shell templating exists to prevent).
 */
export function resolveAppShellLocale(
  urlPath: string,
  search: string | undefined,
  locales?: LocaleRoutingConfig | null
): string {
  const primary = locales?.primary ?? 'en'
  if (urlPath.startsWith('/_')) {
    const candidate = search ? new URLSearchParams(search).get('locale') : null
    const match = candidate ? matchLocaleCode(candidate, locales?.active) : null
    return match ?? primary
  }
  return stripLocalePrefix(urlPath, locales)?.locale ?? primary
}
