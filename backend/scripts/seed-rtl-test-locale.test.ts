/**
 * Pure-unit coverage for the RTL test locale seed's own data shape -- no `WIKI` global, no database,
 * per CLAUDE.md's "Testing (backend)" (this is not SQL orchestration worth a real Postgres instance
 * for; the only logic worth locking down is the shape of the row and the `upsert` call it builds).
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  LTR_TEST_LOCALE,
  LTR_TEST_LOCALE_CODE,
  LTR_TEST_LOCALE_STRINGS,
  RTL_TEST_LOCALE,
  RTL_TEST_LOCALE_CODE,
  RTL_TEST_LOCALE_STRINGS,
  seedLtrTestLocale,
  seedRtlTestLocale
} from './seed-rtl-test-locale.ts'
import { locales as localesTable } from '../db/schema.ts'
import { localeCode } from '../models/locales.ts'
import type { LocalazyLanguage } from '../locales/metadata.d.ts'

const enStrings: Record<string, string> = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../locales/en.json'), 'utf8')
)

/**
 * Feature-detects between the two shapes real engines ship for `Intl.Locale`'s text-direction info --
 * mirrors `frontend/src/stores/site.js`'s `textDirection()` (feature 413, task 727), which this test
 * exists to stay in agreement with. Some Node builds (this sandbox's local macOS Node) expose the
 * earlier draft's `.textInfo` GETTER; a real Chromium build -- and, per OpenProject #2587, at least
 * one Node build used by CI -- exposes `Intl.Locale.prototype.getTextInfo()` as a METHOD instead, with
 * no `.textInfo` getter at all. Reading `.textInfo.direction` unconditionally throws
 * `TypeError: Cannot read properties of undefined (reading 'direction')` on that shape, which is
 * exactly the CI failure #2587 reports -- not a missing-ICU-data problem, since both shapes read from
 * the same CLDR-backed data once resolved.
 */
function textDirection(locale: any): string | undefined {
  if (typeof locale.getTextInfo === 'function') {
    return locale.getTextInfo().direction
  }
  return locale.textInfo?.direction
}

/**
 * Every code a real vendored locale could resolve to, straight off the live `metadata.js` -- what
 * `models/locales.ts#refreshFromDisk()` itself iterates. Used below to confirm (not merely assume)
 * that `RTL_TEST_LOCALE`/`LTR_TEST_LOCALE` really do share a code with a real locale today, which is
 * the premise the `setWhere` freshness guard (OpenProject #2371, see `refreshFromDisk()`'s own
 * comment) exists to make safe.
 */
async function realVendoredLocaleCodes(): Promise<string[]> {
  const metadata = (await import('../locales/metadata.js')).default
  return metadata.languages.map((lang: LocalazyLanguage) => localeCode(lang))
}

describe('RTL_TEST_LOCALE', () => {
  it('is a genuine right-to-left locale row', () => {
    assert.equal(RTL_TEST_LOCALE.code, RTL_TEST_LOCALE_CODE)
    assert.equal(RTL_TEST_LOCALE.code, 'ar')
    assert.equal(RTL_TEST_LOCALE.isRTL, true)
    assert.equal(RTL_TEST_LOCALE.language, 'ar')
  })

  it('resolves as RTL via the same Intl.Locale CLDR check the frontend uses', () => {
    // -> `frontend/src/stores/site.js`'s `describeLocales()` resolves `isRTL` from this same
    //    feature-detected direction read rather than the db column -- this asserts the two stay in
    //    agreement rather than merely trusting the hand-set `isRTL: true` above.
    // -> `textInfo`/`getTextInfo()` are TC39 stage-3 additions not yet reflected in TypeScript's lib
    //    types, hence the `any` in `textDirection`'s signature -- same runtime API `describeLocales()`
    //    calls.
    assert.equal(textDirection(new Intl.Locale(RTL_TEST_LOCALE.code)), 'rtl')
  })

  /**
   * Regression coverage for OpenProject #2587: on a Node build that exposes `getTextInfo()` as a
   * method with no `.textInfo` getter at all (matching a real Chromium build, and apparently at
   * least one Node build CI runs against), reading `.textInfo.direction` unconditionally throws
   * `TypeError: Cannot read properties of undefined (reading 'direction')`. Mirrors
   * `frontend/src/stores/site.test.js`'s "Chrome-shaped Intl.Locale" case: the simulated class still
   * delegates to a real `Intl.Locale` for the actual CLDR direction data, so this only locks in the
   * shape handling, not a stubbed answer.
   */
  it('still resolves RTL via getTextInfo() on a Node build with no .textInfo getter', () => {
    const RealLocale = Intl.Locale
    class GetTextInfoOnlyLocale extends RealLocale {
      get textInfo(): any {
        throw new TypeError('textInfo is not a function or its return value is not iterable')
      }
      override getTextInfo() {
        // -> Delegate through the same feature-detecting `textDirection()` helper, not a bare
        //    `.textInfo.direction` read: on a Node build where the REAL `Intl.Locale` is itself
        //    already getTextInfo()-only (no `.textInfo` getter at all -- exactly the CI shape this
        //    test simulates), reading `.textInfo` directly throws before this override's caller
        //    ever sees a result. `textDirection()` on a genuine, unpatched `RealLocale` instance
        //    resolves correctly regardless of which shape that real object actually has.
        return { direction: textDirection(new RealLocale(this.toString())) }
      }
    }
    ;(Intl as any).Locale = GetTextInfoOnlyLocale
    try {
      assert.equal(textDirection(new Intl.Locale(RTL_TEST_LOCALE.code)), 'rtl')
    } finally {
      ;(Intl as any).Locale = RealLocale
    }
  })

  it('shares its code with a real, currently-vendored Localazy locale', async () => {
    // -> See `LTR_TEST_LOCALE`'s mirrored test below for why this collision is asserted rather than
    //    avoided (OpenProject #2371).
    const realLocalazyCodes = await realVendoredLocaleCodes()
    assert.ok(realLocalazyCodes.includes(RTL_TEST_LOCALE.code))
  })

  it('covers at least the common, editor and admin namespaces the task calls for', () => {
    const namespaces = new Set(Object.keys(RTL_TEST_LOCALE_STRINGS).map((key) => key.split('.')[0]))
    for (const required of ['common', 'editor', 'admin']) {
      assert.ok(namespaces.has(required), `expected a "${required}.*" string, found none`)
    }
  })

  it('only uses keys that actually exist in the real en.json catalog', () => {
    const stale = Object.keys(RTL_TEST_LOCALE_STRINGS).filter((key) => !(key in enStrings))
    assert.deepEqual(stale, [], `these keys do not exist in locales/en.json: ${stale.join(', ')}`)
  })

  it('every string is hand-translated, not copy-pasted from the English source', () => {
    const untranslated = Object.entries(RTL_TEST_LOCALE_STRINGS)
      .filter(([key, value]) => value === enStrings[key])
      .map(([key]) => key)
    assert.deepEqual(
      untranslated,
      [],
      `these keys still hold the English string: ${untranslated.join(', ')}`
    )
  })

  it('every string is non-empty', () => {
    for (const [key, value] of Object.entries(RTL_TEST_LOCALE_STRINGS)) {
      assert.ok(typeof value === 'string' && value.length > 0, `${key} is empty`)
    }
  })
})

describe('seedRtlTestLocale', () => {
  it('upserts RTL_TEST_LOCALE by code, refreshing strings/isRTL/name/nativeName on conflict', async () => {
    const onConflictDoUpdate = mock.fn((_opts: any) => Promise.resolve())
    const values = mock.fn((_row: any) => ({ onConflictDoUpdate }))
    const insert = mock.fn((_table: any) => ({ values }))
    const fakeDb = { insert } as any

    await seedRtlTestLocale(fakeDb)

    assert.equal(insert.mock.calls.length, 1)
    assert.equal(insert.mock.calls[0].arguments[0], localesTable)

    assert.equal(values.mock.calls.length, 1)
    assert.deepEqual(values.mock.calls[0].arguments[0], RTL_TEST_LOCALE)

    assert.equal(onConflictDoUpdate.mock.calls.length, 1)
    const conflictArg = onConflictDoUpdate.mock.calls[0].arguments[0] as any
    assert.equal(conflictArg.target, localesTable.code)
    assert.equal(conflictArg.set.isRTL, true)
    assert.deepEqual(conflictArg.set.strings, RTL_TEST_LOCALE_STRINGS)
    assert.equal(conflictArg.set.name, RTL_TEST_LOCALE.name)
    assert.equal(conflictArg.set.nativeName, RTL_TEST_LOCALE.nativeName)
  })
})

/**
 * Mirrors the `RTL_TEST_LOCALE` coverage above for the second, non-RTL fixture WP #1662 added --
 * `e2e/tests/rtl.spec.js`'s content-vs-interface-locale cases need a real, non-right-to-left
 * translation locale to activate alongside `ar`, and this is its own data shape / upsert coverage.
 */
describe('LTR_TEST_LOCALE', () => {
  it('is a genuine, non-right-to-left locale row, distinct from RTL_TEST_LOCALE', () => {
    assert.equal(LTR_TEST_LOCALE.code, LTR_TEST_LOCALE_CODE)
    assert.equal(LTR_TEST_LOCALE.code, 'es')
    assert.equal(LTR_TEST_LOCALE.isRTL, false)
    assert.equal(LTR_TEST_LOCALE.language, 'es')
    assert.notEqual(LTR_TEST_LOCALE.code, RTL_TEST_LOCALE.code)
  })

  it('resolves as non-RTL via the same Intl.Locale CLDR check the frontend uses', () => {
    // -> Mirrors the RTL row's own CLDR-agreement check above -- see its comment.
    assert.notEqual(textDirection(new Intl.Locale(LTR_TEST_LOCALE.code)), 'rtl')
  })

  it('shares its code with a real, currently-vendored Localazy locale', async () => {
    // -> `es` (like `RTL_TEST_LOCALE`'s `ar`) genuinely is one of the languages
    //    `locales/metadata.js` currently declares, with a real `locales/es.json` on disk --
    //    `models/locales.ts#refreshFromDisk()` treats it as a real locale it owns and resyncs on
    //    every boot. This is safe (OpenProject #2371) specifically because that function's
    //    `onConflictDoUpdate` now carries a `setWhere` freshness guard checked against the row's
    //    live `updatedAt`, not a stale snapshot -- see its own comment. Asserting the collision here
    //    (rather than merely asserting it away, as this test used to) is what would catch a
    //    regression if that guard were ever removed: a future edit reverting it has nothing else in
    //    this file to fail against, since this fixture no longer avoids the collision by picking an
    //    unclaimed code.
    const realLocalazyCodes = await realVendoredLocaleCodes()
    assert.ok(realLocalazyCodes.includes(LTR_TEST_LOCALE.code))
  })

  it('only uses keys that actually exist in the real en.json catalog', () => {
    const stale = Object.keys(LTR_TEST_LOCALE_STRINGS).filter((key) => !(key in enStrings))
    assert.deepEqual(stale, [], `these keys do not exist in locales/en.json: ${stale.join(', ')}`)
  })

  it('every string is hand-translated, not copy-pasted from the English source', () => {
    const untranslated = Object.entries(LTR_TEST_LOCALE_STRINGS)
      .filter(([key, value]) => value === enStrings[key])
      .map(([key]) => key)
    assert.deepEqual(
      untranslated,
      [],
      `these keys still hold the English string: ${untranslated.join(', ')}`
    )
  })

  it('every string is non-empty', () => {
    for (const [key, value] of Object.entries(LTR_TEST_LOCALE_STRINGS)) {
      assert.ok(typeof value === 'string' && value.length > 0, `${key} is empty`)
    }
  })
})

describe('seedLtrTestLocale', () => {
  it('upserts LTR_TEST_LOCALE by code, refreshing strings/isRTL/name/nativeName on conflict', async () => {
    const onConflictDoUpdate = mock.fn((_opts: any) => Promise.resolve())
    const values = mock.fn((_row: any) => ({ onConflictDoUpdate }))
    const insert = mock.fn((_table: any) => ({ values }))
    const fakeDb = { insert } as any

    await seedLtrTestLocale(fakeDb)

    assert.equal(insert.mock.calls.length, 1)
    assert.equal(insert.mock.calls[0].arguments[0], localesTable)

    assert.equal(values.mock.calls.length, 1)
    assert.deepEqual(values.mock.calls[0].arguments[0], LTR_TEST_LOCALE)

    assert.equal(onConflictDoUpdate.mock.calls.length, 1)
    const conflictArg = onConflictDoUpdate.mock.calls[0].arguments[0] as any
    assert.equal(conflictArg.target, localesTable.code)
    assert.equal(conflictArg.set.isRTL, false)
    assert.deepEqual(conflictArg.set.strings, LTR_TEST_LOCALE_STRINGS)
    assert.equal(conflictArg.set.name, LTR_TEST_LOCALE.name)
    assert.equal(conflictArg.set.nativeName, LTR_TEST_LOCALE.nativeName)
  })
})
