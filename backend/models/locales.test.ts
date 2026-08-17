import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localeCode } from './locales.ts'

/**
 * `refreshFromDisk` (see `locales.ts`) logs a `[ SKIPPED ]` warning at boot for every language
 * declared in `locales/metadata.js` that has no matching `backend/locales/<code>.json` file on
 * disk. This is a pure, no-`WIKI`, no-database check of that exact invariant: every declared
 * language resolves to a real file. It is what "a fresh boot produces zero [ SKIPPED ] locale
 * warnings" (task 690's stated done-condition) reduces to, without needing to actually boot.
 */
describe('locales metadata <-> vendored files', () => {
  const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../locales')

  test('every language in metadata.js has a matching backend/locales/<code>.json file', async () => {
    const { default: localesMeta } = await import('../locales/metadata.js')

    const missing = localesMeta.languages
      .map((lang) => localeCode(lang))
      .filter((code) => !existsSync(path.join(localesDir, `${code}.json`)))

    assert.deepEqual(missing, [], `missing strings files for: ${missing.join(', ')}`)
  })

  test('declares at least 40 languages, including the six previously-committed ones', async () => {
    const { default: localesMeta } = await import('../locales/metadata.js')
    const codes = new Set(localesMeta.languages.map((lang) => localeCode(lang)))

    assert.ok(
      localesMeta.languages.length >= 40,
      `expected at least 40 languages, got ${localesMeta.languages.length}`
    )
    for (const required of ['de', 'en', 'fr', 'pt-BR', 'ru', 'zh-Hans']) {
      assert.ok(codes.has(required), `expected metadata.js to still declare ${required}`)
    }
  })

  test('every language has a distinct code and a pluralType function (shape-compatibility)', async () => {
    const { default: localesMeta } = await import('../locales/metadata.js')
    const codes = localesMeta.languages.map((lang) => localeCode(lang))

    assert.equal(new Set(codes).size, codes.length, 'expected no duplicate language codes')
    for (const lang of localesMeta.languages) {
      assert.equal(typeof lang.pluralType, 'function', `${localeCode(lang)} is missing pluralType`)
      assert.equal(typeof lang.pluralType(1), 'string')
    }
  })

  test('localeCode() builds language[-region][-script]', () => {
    assert.equal(localeCode({ language: 'de', region: '', script: '' }), 'de')
    assert.equal(localeCode({ language: 'pt', region: 'BR', script: '' }), 'pt-BR')
    assert.equal(localeCode({ language: 'zh', region: '', script: 'Hans' }), 'zh-Hans')
  })
})
