/**
 * Server-side templating of `<html lang dir>` in the compiled SPA shell (`assets/index.html`). The
 * bundle hardcodes both, and `App.vue`'s `applyLocale` corrects them only once its JS has run, so
 * until then a reader on an RTL locale would see an LTR document.
 *
 * Only `lang` and `dir`: a dark-mode class would depend on the signed-in user's theme, which needs
 * a session read this does not do.
 */

import { readFile as fsReadFile } from 'node:fs/promises'
import { stat as fsStat } from 'node:fs/promises'
import type { LocaleRoutingConfig } from './localeRouting.ts'
import { matchLocaleCode, stripLocalePrefix } from './localeRouting.ts'

const HTML_TAG_PATTERN = /<html\b[^>]*>/i

export interface AppShellTemplateOptions {
  lang: string
  isRTL: boolean
}

/**
 * Matches the opening `<html>` tag however it is attributed, not the literal `frontend/index.html`
 * ships, and replaces it whole. With no `<html>` tag the document comes back unchanged: templating
 * is an enhancement, never a reason to fail serving the shell.
 */
export function templateAppShell(html: string, { lang, isRTL }: AppShellTemplateOptions): string {
  if (!HTML_TAG_PATTERN.test(html)) {
    return html
  }
  return html.replace(HTML_TAG_PATTERN, `<html lang="${lang}" dir="${isRTL ? 'rtl' : 'ltr'}">`)
}

export interface AppShellFragments {
  head?: string
  bodyEnd?: string
}

export function mergeShellFragments(...parts: AppShellFragments[]): AppShellFragments {
  let head = ''
  let bodyEnd = ''
  for (const part of parts) {
    head += part.head ?? ''
    bodyEnd += part.bodyEnd ?? ''
  }
  const merged: AppShellFragments = {}
  if (head) merged.head = head
  if (bodyEnd) merged.bodyEnd = bodyEnd
  return merged
}

const HEAD_CLOSE_PATTERN = /<\/head\s*>/i
const BODY_CLOSE_PATTERN = /<\/body\s*>/gi

export function insertIntoAppShell(template: string, fragments: AppShellFragments): string {
  const { head, bodyEnd } = fragments
  const headAt = head ? template.search(HEAD_CLOSE_PATTERN) : -1
  let bodyAt = -1
  if (bodyEnd) {
    for (const match of template.matchAll(BODY_CLOSE_PATTERN)) {
      bodyAt = match.index
    }
  }
  if (headAt === -1 && bodyAt === -1) {
    return template
  }
  const inserts: Array<[number, string]> = []
  if (headAt !== -1) inserts.push([headAt, head!])
  if (bodyAt !== -1) inserts.push([bodyAt, bodyEnd!])
  inserts.sort((a, b) => a[0] - b[0])
  let result = ''
  let cursor = 0
  for (const [at, fragment] of inserts) {
    result += template.slice(cursor, at) + fragment
    cursor = at
  }
  return result + template.slice(cursor)
}

/**
 * Mirrors the frontend's `resolveRouteLocale`, so the shell is stamped with the locale the booted
 * app will settle on.
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

/** One shell file serves the whole instance, so one cache -- not one per site. */
let cacheState: AppShellCacheState | null = null

/**
 * Memoised per `lang` and invalidated as a whole when the shell's `mtimeMs` changes, i.e. on a fresh
 * `npm run build`. Only a miss reads the file or calls `resolveIsRTL`, which keeps that DB-backed
 * lookup off the hot path.
 *
 * Limitation: a locale's `isRTL` changing without a rebuild is not picked up until the next build or
 * restart. It comes from shipped locale metadata, not an admin setting, so this is a deploy-time
 * edge case.
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

/** Test-only. */
export function resetAppShellCache(): void {
  cacheState = null
}
