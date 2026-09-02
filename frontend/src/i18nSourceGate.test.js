import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #1615 ("Add a CI source-text gate that fails on newly reintroduced untranslated
 * English literals"), the last child of #1586 ("Localize the shared library's 14 English strings,
 * the 41 hardcoded notify messages and the group permission catalog"). oxlint has no i18n rule and
 * this repo runs no `eslint-plugin-vue-i18n`, so a source-text scan -- in the style of
 * `src/css/_page-contents.test.js` -- is the practical guard against regression: it reads every
 * `.vue`/`.js` file under `src` (excluding tests) and flags four shapes of hardcoded English that
 * #1586's other children exist to remove:
 *
 *   1. a capitalised English sentence passed as `message:` to `notify()`
 *   2. the same shape thrown from `new Error(...)`
 *   3. a static `aria-label="…"` or `label="…"` literal under `src/components` / `src/pages`
 *      (a *bound* attribute -- `:aria-label="expr"` -- is excluded: those resolve through `t()`
 *      or a prop already, or are their own separate defect not in this gate's four categories)
 *   4. the specific misspelled literal `'An unexpected error occured.'` (`#1605`'s target),
 *      matched as a substring so it also catches the longer contextual variants
 *      (`'An unexpected error occured while fetching group details.'`) the way
 *      `grep -ro "An unexpected error occured"` does in #1605's own "Done when".
 *
 * Two describe blocks:
 *  - `detectors` exercises each matcher against small in-memory fixtures, independent of the
 *    repository's current state -- this is what proves the *mechanism* correctly flags a
 *    reintroduced literal in each category and stays quiet on clean, translated-looking source.
 *  - `frontend/src source tree` runs those same matchers against the real tree -- the actual CI
 *    gate. #1586's own breakdown note says this child "must land last because it fails against any
 *    surface not yet converted": until #1602, #1597, #1605 and #1610 have all landed, EXPECT this
 *    block to report violations for whichever of those four haven't shipped yet. That is not a
 *    defect in the detector -- it is the gate correctly describing a tree still mid-migration.
 */

const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

// The one deliberate exception: PageHeader.vue's `notImplemented()` toast fires for a feature that
// genuinely doesn't exist yet (#1586's breakdown note excludes it by name) -- it needs its own
// product decision, not a locale key, so the notify() matcher allow-lists this one literal.
const ALLOWED_NOTIFY_MESSAGES = new Set(['Not implemented'])

// DevQuickMenu.vue's own header comment: it is mounted only by a dev server (guarded out of the
// production bundle entirely in App.vue) and deliberately stays hardcoded English -- a dev-only
// locale key would still ship to translators on the next Localazy sync for a screen no reader, in
// any locale, will ever see. Same shape of exception as `ALLOWED_NOTIFY_MESSAGES` above, for the
// static aria-label/label matcher instead.
const ALLOWED_ARIA_LABELS = new Set(['Developer tools'])

const MISSPELLED_UNEXPECTED_ERROR = 'An unexpected error occured'

/**
 * A capitalised, multi-word English sentence literal -- `[A-Z][a-z]+` followed by a space rules out
 * a SCREAMING_SNAKE_CASE error code like `'ERR_PAGE_NOT_FOUND'`, which has no lowercase letter
 * following its first capital, while still matching every one of #1597's 41 real `message:`
 * violations (verified against the pre-fix tree: all 41 match `message: '[A-Z][a-z]+ '`).
 */
function findNotifyMessages(source) {
  const re = /message:\s*'([A-Z][a-z]+ [^']*)'/g
  const hits = []
  let m
  while ((m = re.exec(source))) {
    if (!ALLOWED_NOTIFY_MESSAGES.has(m[1])) hits.push(m[1])
  }
  return hits
}

function findThrownErrors(source) {
  const re = /new Error\('([A-Z][a-z]+ [^']*)'\)/g
  const hits = []
  let m
  while ((m = re.exec(source))) hits.push(m[1])
  return hits
}

// Excludes a *bound* Vue attribute (`:aria-label="…"`, `:label="…"`) via the negative lookbehind --
// those are either already resolved through `t()`/a prop, or a distinct defect (a hardcoded literal
// inside a bound expression, e.g. `:aria-label="'Previous month'"`) outside this gate's four
// categories.
function findStaticAriaOrLabel(source) {
  const re = /(?<![:\w-])(?:aria-label|label)="([A-Z][^"]*)"/g
  const hits = []
  let m
  while ((m = re.exec(source))) {
    if (!ALLOWED_ARIA_LABELS.has(m[1])) hits.push(m[1])
  }
  return hits
}

function findMisspelledUnexpectedError(source) {
  return source.includes(MISSPELLED_UNEXPECTED_ERROR) ? [MISSPELLED_UNEXPECTED_ERROR] : []
}

describe('detectors', () => {
  describe('notify() message literals', () => {
    it('flags a capitalised, multi-word English sentence', () => {
      const source = `notify({ type: 'negative', message: 'Failed to save page changes.' })`
      expect(findNotifyMessages(source)).toEqual(['Failed to save page changes.'])
    })

    it('does not flag a translated call', () => {
      const source = `notify({ type: 'negative', message: t('common.page.saveFailed') })`
      expect(findNotifyMessages(source)).toEqual([])
    })

    it('does not flag a SCREAMING_SNAKE_CASE code (no lowercase letter follows the first capital)', () => {
      const source = `notify({ message: 'ERR_PAGE_NOT_FOUND' })`
      expect(findNotifyMessages(source)).toEqual([])
    })

    it('allow-lists PageHeader.vue’s deliberate "Not implemented" stub', () => {
      const source = `notify({ type: 'negative', message: 'Not implemented' })`
      expect(findNotifyMessages(source)).toEqual([])
    })
  })

  describe('new Error() literals', () => {
    it('flags a capitalised, multi-word English sentence thrown as an Error', () => {
      const source = `throw new Error('Could not fetch system flags.')`
      expect(findThrownErrors(source)).toEqual(['Could not fetch system flags.'])
    })

    it('does not flag a translated fallback', () => {
      const source = `throw new Error(resp?.message || t('common.error.unexpected'))`
      expect(findThrownErrors(source)).toEqual([])
    })
  })

  describe('static aria-label / label literals', () => {
    it('flags an unbound aria-label attribute', () => {
      const source = `<w-btn aria-label="Page Properties" />`
      expect(findStaticAriaOrLabel(source)).toEqual(['Page Properties'])
    })

    it('flags an unbound label attribute', () => {
      const source = `<w-input label="New file name" />`
      expect(findStaticAriaOrLabel(source)).toEqual(['New file name'])
    })

    it('does not flag a bound attribute -- it resolves through t() or a prop elsewhere', () => {
      const source = `<w-btn :aria-label="t('common.page.properties')" />`
      expect(findStaticAriaOrLabel(source)).toEqual([])
    })

    it("allow-lists DevQuickMenu.vue's deliberately hardcoded dev-only tab", () => {
      const source = `<button aria-label="Developer tools">dev</button>`
      expect(findStaticAriaOrLabel(source)).toEqual([])
    })
  })

  describe('the misspelled "An unexpected error occured" literal', () => {
    it('flags the bare literal', () => {
      expect(findMisspelledUnexpectedError("'An unexpected error occured.'")).toEqual([
        'An unexpected error occured'
      ])
    })

    it('flags the longer contextual variant as a substring, matching #1605’s own grep', () => {
      expect(
        findMisspelledUnexpectedError("'An unexpected error occured while fetching group details.'")
      ).toEqual(['An unexpected error occured'])
    })

    it('does not flag the correctly spelled, translated key', () => {
      expect(findMisspelledUnexpectedError("t('common.error.unexpected')")).toEqual([])
    })
  })
})

describe('frontend/src source tree', () => {
  const allFiles = listSourceFiles(SRC_ROOT, { ext: ['.vue', '.js'], skip: ['.test.js'] })
  const componentAndPageFiles = allFiles.filter(
    (f) => f.includes(`${SRC_ROOT}/components/`) || f.includes(`${SRC_ROOT}/pages/`)
  )

  it('carries no capitalised English sentence passed as message: to notify()', () => {
    const violations = []
    for (const file of allFiles) {
      const hits = findNotifyMessages(readFileSync(file, 'utf-8'))
      for (const hit of hits) violations.push(`${file}: '${hit}'`)
    }
    expect(violations).toEqual([])
  })

  it('carries no capitalised English sentence thrown from new Error()', () => {
    const violations = []
    for (const file of allFiles) {
      const hits = findThrownErrors(readFileSync(file, 'utf-8'))
      for (const hit of hits) violations.push(`${file}: '${hit}'`)
    }
    expect(violations).toEqual([])
  })

  it('carries no static aria-label="…" or label="…" English literal under components/ or pages/', () => {
    const violations = []
    for (const file of componentAndPageFiles) {
      const hits = findStaticAriaOrLabel(readFileSync(file, 'utf-8'))
      for (const hit of hits) violations.push(`${file}: '${hit}'`)
    }
    expect(violations).toEqual([])
  })

  it('carries no instance of the misspelled "An unexpected error occured" literal', () => {
    const violations = []
    for (const file of allFiles) {
      const hits = findMisspelledUnexpectedError(readFileSync(file, 'utf-8'))
      for (const hit of hits) violations.push(file)
    }
    expect(violations).toEqual([])
  })
})
