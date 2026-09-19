import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * oxlint has no i18n rule and this repo runs no `eslint-plugin-vue-i18n`, so a source-text scan is
 * the guard against reintroduced hardcoded English. `detectors` proves each matcher against
 * in-memory fixtures, independent of the tree's current state; `frontend/src source tree` is the
 * gate itself.
 */

const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

// TODO: nothing emits 'Not implemented' any more -- PageHeader.vue's `notImplemented()` stub, which
// this allow-listed, is gone. Drop the allow-list and its detector case.
const ALLOWED_NOTIFY_MESSAGES = new Set(['Not implemented'])

// DevQuickMenu.vue is mounted only by a dev server and stays hardcoded English: a dev-only locale
// key would still ship to translators, for a screen no reader will ever see.
const ALLOWED_ARIA_LABELS = new Set(['Developer tools'])

const MISSPELLED_UNEXPECTED_ERROR = 'An unexpected error occured'

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

// The negative lookbehind excludes a bound attribute (`:aria-label="…"`). A hardcoded literal inside
// a bound expression (`:aria-label="'Previous month'"`) is a defect this gate does not cover.
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
