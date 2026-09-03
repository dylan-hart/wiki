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

import { readFile as fsReadFile } from 'node:fs/promises'
import { stat as fsStat } from 'node:fs/promises'
import type { LocaleRoutingConfig } from './localeRouting.ts'
import { matchLocaleCode, stripLocalePrefix } from './localeRouting.ts'

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

/** Filesystem access `getTemplatedAppShell` needs, injectable so tests never touch real disk. */
export interface AppShellReaderDeps {
  readFile: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ mtimeMs: number }>
}

const defaultReaderDeps: AppShellReaderDeps = {
  readFile: (p) => fsReadFile(p, 'utf8'),
  stat: (p) => fsStat(p)
}

interface AppShellCacheEntry {
  isRTL: boolean
  templated: string
}

interface AppShellCacheState {
  mtimeMs: number
  entriesByLang: Map<string, AppShellCacheEntry>
}

/**
 * Module-level, process-lifetime cache: the compiled shell is served from `assets/index.html`, one
 * file for the whole instance, so there is exactly one cache to keep -- not one per site or request.
 */
let cacheState: AppShellCacheState | null = null

/**
 * Templated app shell for one `lang`, memoised per `(lang, isRTL)` and invalidated as a whole
 * whenever the shell file's `mtimeMs` changes (i.e. a fresh `npm run build`) -- see `index.ts`'s
 * `setNotFoundHandler` comment for why the file is deliberately re-stat'd on every request rather
 * than watched: "`npm run build` while the server is up should be enough" must keep holding.
 *
 * `resolveIsRTL` is called, and the shell file is read, only on a cache miss for the current `lang`
 * (a new `lang` never seen since the last rebuild, or the very first request after one) -- so the
 * common case of a repeat request for an already-seen `lang` neither re-reads the file nor calls
 * `WIKI.models.locales.getLocales()` (the `resolveIsRTL` this is called with in `index.ts`), taking
 * that DB-backed lookup off the hot path along with the file read + regex substitution.
 *
 * Known limitation: because invalidation is tied to the shell file's `mtimeMs` rather than to locale
 * data changing, a locale's `isRTL` flag being corrected via a locale re-sideload without an
 * accompanying frontend rebuild would not be picked up until the next `npm run build` or process
 * restart. `isRTL` is sourced from shipped locale metadata (`locales/metadata.js`), not an
 * admin-editable per-locale setting, so this is a narrow, deploy-adjacent edge case rather than a
 * live one.
 */
export async function getTemplatedAppShell(
  shellPath: string,
  lang: string,
  resolveIsRTL: () => boolean | Promise<boolean>,
  deps: AppShellReaderDeps = defaultReaderDeps
): Promise<string> {
  const { mtimeMs } = await deps.stat(shellPath)
  if (!cacheState || cacheState.mtimeMs !== mtimeMs) {
    cacheState = { mtimeMs, entriesByLang: new Map() }
  }
  const cached = cacheState.entriesByLang.get(lang)
  if (cached) {
    return cached.templated
  }
  const [isRTL, html] = await Promise.all([resolveIsRTL(), deps.readFile(shellPath)])
  const templated = templateAppShell(html, { lang, isRTL })
  cacheState.entriesByLang.set(lang, { isRTL, templated })
  return templated
}

/** Test-only: clears the module-level memo so each test starts from a clean cache. */
export function resetAppShellCache(): void {
  cacheState = null
}
