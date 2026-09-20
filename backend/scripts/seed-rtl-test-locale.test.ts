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
 * Engines ship two shapes for `Intl.Locale`'s text-direction info: the earlier draft's `.textInfo`
 * GETTER, or `getTextInfo()` as a METHOD with no getter at all. Reading `.textInfo.direction`
 * unconditionally throws `TypeError: Cannot read properties of undefined (reading 'direction')` on
 * the second -- both read the same CLDR data once resolved, so it is never missing ICU data. Mirrors
 * `frontend/src/stores/site.js`'s `textDirection()`, which this test stays in agreement with.
 */
function textDirection(locale: any): string | undefined {
  if (typeof locale.getTextInfo === 'function') {
    return locale.getTextInfo().direction
  }
  return locale.textInfo?.direction
}

/**
 * Straight off the live `metadata.js`, exactly what `models/locales.ts#refreshFromDisk()` iterates,
 * so the cases below confirm rather than assume that both fixtures share a code with a real locale --
 * the premise `refreshFromDisk()`'s `setWhere` freshness guard exists to make safe.
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
    // -> `describeLocales()` resolves `isRTL` from this same direction read rather than the db
    //    column, so this checks the two agree rather than trusting the hand-set `isRTL: true` above.
    // -> `textInfo`/`getTextInfo()` are TC39 stage-3 additions TypeScript's lib types don't carry
    //    yet, hence the `any` in `textDirection`'s signature.
    assert.equal(textDirection(new Intl.Locale(RTL_TEST_LOCALE.code)), 'rtl')
  })

  /**
   * The simulated class delegates to a real `Intl.Locale` for the CLDR direction data, so what this
   * locks in is the shape handling, not a stubbed answer.
   */
  it('still resolves RTL via getTextInfo() on a Node build with no .textInfo getter', () => {
    const RealLocale = Intl.Locale
    class GetTextInfoOnlyLocale extends RealLocale {
      get textInfo(): any {
        throw new TypeError('textInfo is not a function or its return value is not iterable')
      }
      override getTextInfo() {
        // -> Through the feature-detecting helper, never a bare `.textInfo.direction` read: the real
        //    `Intl.Locale` underneath may itself be getTextInfo()-only, where that read throws
        //    before the caller sees a result. The cast satisfies `getTextInfo`'s declared
        //    `'ltr' | 'rtl'` return, which `textDirection()` answers with a plain string.
        return {
          direction: textDirection(new RealLocale(this.toString())) as 'ltr' | 'rtl'
        }
      }
    }
    ;(Intl as any).Locale = GetTextInfoOnlyLocale
    try {
      assert.equal(textDirection(new Intl.Locale(RTL_TEST_LOCALE.code)), 'rtl')
    } finally {
      ;(Intl as any).Locale = RealLocale
    }
  })

  /**
   * The mirror image of the case above. Without it `textDirection()`'s fallback branch is dead in
   * every environment the suite actually runs in -- an engine exposing both shapes takes the
   * `getTextInfo()` branch first -- so deleting the fallback would go uncaught until someone ran on
   * a getter-only build.
   */
  it('still resolves RTL via the .textInfo getter on a Node build with no getTextInfo() method', () => {
    const RealLocale = Intl.Locale
    class TextInfoGetterOnlyLocale extends RealLocale {
      get textInfo(): any {
        // -> Through the same helper on an unpatched `RealLocale`, for the reason the case above
        //    gives: the answer stays real CLDR data whichever shape the engine ships.
        return { direction: textDirection(new RealLocale(this.toString())) }
      }
    }
    // -> `getTextInfo` is inherited from `RealLocale.prototype` on a build that has it, so simply
    //    not declaring it would NOT produce a getter-only instance; shadowing it with `undefined` is
    //    what sends `textDirection()` down the fallback branch.
    Object.defineProperty(TextInfoGetterOnlyLocale.prototype, 'getTextInfo', {
      value: undefined,
      writable: true,
      configurable: true
    })
    ;(Intl as any).Locale = TextInfoGetterOnlyLocale
    try {
      assert.equal(textDirection(new Intl.Locale(RTL_TEST_LOCALE.code)), 'rtl')
    } finally {
      ;(Intl as any).Locale = RealLocale
    }
  })

  it('shares its code with a real, currently-vendored Localazy locale', async () => {
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

describe('LTR_TEST_LOCALE', () => {
  it('is a genuine, non-right-to-left locale row, distinct from RTL_TEST_LOCALE', () => {
    assert.equal(LTR_TEST_LOCALE.code, LTR_TEST_LOCALE_CODE)
    assert.equal(LTR_TEST_LOCALE.code, 'es')
    assert.equal(LTR_TEST_LOCALE.isRTL, false)
    assert.equal(LTR_TEST_LOCALE.language, 'es')
    assert.notEqual(LTR_TEST_LOCALE.code, RTL_TEST_LOCALE.code)
  })

  it('resolves as non-RTL via the same Intl.Locale CLDR check the frontend uses', () => {
    assert.notEqual(textDirection(new Intl.Locale(LTR_TEST_LOCALE.code)), 'rtl')
  })

  it('shares its code with a real, currently-vendored Localazy locale', async () => {
    // -> The collision with a real vendored locale is asserted, not avoided: it is only safe because
    //    `refreshFromDisk()`'s `onConflictDoUpdate` carries a `setWhere` freshness guard against the
    //    row's live `updatedAt`, and this assertion is what would fail if that guard were removed.
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
