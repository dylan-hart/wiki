/**
 * One-off seed for two synthetic locales, for validating feature 413 ("RTL support end-to-end") and
 * WP #1662 (the content-vs-interface locale split) end to end.
 *
 * `locales/metadata.js` (Localazy-generated) has grown a great deal since this file was first
 * written -- as of OpenProject #2371 it lists 56 languages, `ar` and `es` among them, each with a
 * real, vendored `locales/<code>.json` file on disk (this file used to claim only
 * de/en/fr/pt-BR/ru/zh existed; that claim is now false and was corrected as part of #2371). That
 * makes `ar`/`es` real locales `models/locales.ts#refreshFromDisk()` owns and resyncs on every boot
 * -- deliberately reused here anyway rather than picked around, because `refreshFromDisk()`'s own
 * `onConflictDoUpdate` now carries a `setWhere` freshness guard (#2371) that makes this safe: it only
 * ever overwrites a locale row whose CURRENT `updatedAt` (re-checked atomically at write time, not
 * from a stale in-memory snapshot) is still older than the vendored file's own mtime. This seed's
 * `updatedAt: now()` is always newer than a checked-out file's mtime, so a boot's `refreshFromDisk()`
 * -- however it interleaves with this seed's own write -- can never clobber it. See that guard's own
 * comment for the exact race this closes.
 *
 * This script inserts two hand-translated stand-ins directly into the `locales` table:
 *
 *   - `RTL_TEST_LOCALE` (`ar`, `isRTL: true`) -- enough real Arabic strings across the namespaces the
 *     reading view, editor toolbars and admin chrome actually read from (`common.*`,
 *     `editor.markup.*`, `admin.*`, `auth.*`, `welcome.*`) to exercise the whole rendering path with
 *     `isRTL: true` genuinely in effect, per `models/locales.ts`'s `getLocales()`/`getStrings()`.
 *     Deliberately NOT the real, Localazy-sourced `ar.json` translation: that file's completeness is
 *     whatever fraction of ~2,800 keys the crowd-sourced project happens to have translated at any
 *     given moment (42% as of this writing), covering an unpredictable, shifting subset of keys --
 *     unusable as a fixture an e2e spec can assert specific translated strings against.
 *   - `LTR_TEST_LOCALE` (`es`, `isRTL: false`) -- a second, non-right-to-left locale, so
 *     `e2e/tests/rtl.spec.js` can assert `<html lang>` follows a page's own content locale even when
 *     that locale isn't RTL (WP #1655's point that the `lang` half is wrong on *any* translated page,
 *     not only an RTL one).
 *
 * Two ways to run it:
 *   - `import { seedRtlTestLocale, RTL_TEST_LOCALE }` (or the `Ltr`-prefixed equivalents) from
 *     `'./seed-rtl-test-locale.ts'`, from a script or test that already has a Drizzle `db` handle
 *     (e.g. `test/db.ts`'s `setupTestDb()`).
 *   - `node backend/scripts/seed-rtl-test-locale.ts` (from the repo root, or anywhere -- it builds
 *     its own connections from `DATABASE_URL` and does not depend on `WIKI` or `cwd`), which upserts
 *     both rows into whichever database `DATABASE_URL` names and exits.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { locales as localesTable } from '../db/schema.ts'
import { relations } from '../db/relations.ts'
import type { WikiDb } from '../core/db.ts'

/** The synthetic locale's own code -- chosen over `he` because CLDR's `Intl.Locale('ar').textInfo.direction`
 *  is `'rtl'`, which is what `frontend/src/stores/site.js`'s `describeLocales()` resolves `isRTL` from. */
export const RTL_TEST_LOCALE_CODE = 'ar'

/**
 * Hand-translated Arabic strings, keyed exactly like `locales/en.json` (flat dot-paths, not nested
 * objects -- see that file). Not a translation of the whole catalog: just enough of `common.*`,
 * `editor.markup.*`, `admin.*`, `auth.*` and `welcome.*` to give the reading view, the NavSidebar/
 * PageToc/PageHeader chrome, the Markdown editor's toolbar, and the admin area's own chrome and
 * locale-switcher something real to render, per task 727's brief.
 *
 * `editor.markup.*` is the Markdown editor's toolbar (`EditorMarkdown.vue`) -- the WYSIWYG editor's
 * own toolbar (`EditorWysiwyg.vue`) has no i18n wiring at all (its `title:` labels are hardcoded
 * English strings passed straight to `aria-label`, not run through `t()`), so no amount of seeding
 * here changes what it renders; see `docs/variances.md`.
 */
export const RTL_TEST_LOCALE_STRINGS: Record<string, string> = {
  // -> common: sidebar / header / page chrome (reading view, NavSidebar, PageToc, PageHeader)
  'common.sidebar.mainMenu': 'القائمة الرئيسية',
  'common.sidebar.browse': 'استعراض',
  'common.sidebar.currentDirectory': 'المجلد الحالي',
  'common.sidebar.root': '(الجذر)',
  'common.header.search': 'بحث...',
  'common.page.toc': 'جدول المحتويات',
  'common.page.contents': 'المحتويات',
  'common.page.watch': 'مراقبة الصفحة',
  'common.page.unwatch': 'إيقاف المراقبة',
  'common.page.editPage': 'تحرير الصفحة',
  'common.page.lastEditedBy': 'آخر تحرير بواسطة',
  'common.page.share': 'مشاركة',
  'common.page.bookmark': 'إضافة إشارة مرجعية',
  'common.page.published': 'منشور',
  'common.page.private': 'خاص',
  // -> common.actions: generic buttons used throughout the reading view and admin alike
  'common.actions.save': 'حفظ',
  'common.actions.cancel': 'إلغاء',
  'common.actions.edit': 'تحرير',
  'common.actions.delete': 'حذف',
  'common.actions.close': 'إغلاق',
  'common.actions.ok': 'حسناً',
  'common.actions.login': 'تسجيل الدخول',
  'common.actions.apply': 'تطبيق',
  'common.actions.refresh': 'تحديث',
  'common.actions.viewDocs': 'عرض الوثائق',
  // -> editor.markup: the Markdown editor's own toolbar (EditorMarkdown.vue)
  'editor.markup.bold': 'غامق',
  'editor.markup.italic': 'مائل',
  'editor.markup.strikethrough': 'يتوسطه خط',
  'editor.markup.header': 'عنوان',
  'editor.markup.blockquote': 'اقتباس',
  'editor.markup.subscript': 'منخفض',
  'editor.markup.superscript': 'مرتفع',
  'editor.markup.insertLink': 'إدراج رابط',
  'editor.markup.insertAssets': 'إدراج أصول',
  'editor.markup.insertCodeBlock': 'إدراج كتلة برمجية',
  'editor.markup.insertTable': 'إدراج جدول',
  'editor.markup.insertEmoji': 'إدراج رمز تعبيري',
  'editor.markup.insertIcon': 'إدراج أيقونة',
  // -> admin: the admin chrome itself, including AdminLocale.vue's own screen
  'admin.adminArea': 'منطقة الإدارة',
  'admin.locale.title': 'اللغة',
  'admin.locale.subtitle': 'إعدادات التعريب لهذا الموقع',
  'admin.locale.settings': 'الإعدادات',
  'admin.locale.primary': 'اللغة الأساسية',
  'admin.locale.active': 'اللغات المفعّلة',
  'admin.locale.saveSuccess': 'تم حفظ إعدادات اللغة بنجاح.',
  'admin.locale.loadFailed': 'فشل تحميل إعدادات اللغة.',
  // -> auth: login screen chrome
  'auth.actions.login': 'تسجيل الدخول',
  'auth.enterCredentials': 'أدخل بيانات الاعتماد الخاصة بك',
  // -> welcome: first-run chrome
  'welcome.title': 'مرحباً بك في Cardinal.js!',
  'welcome.subtitle': 'لنبدأ...'
}

/** The full row this script upserts -- exported so tests can assert its shape directly. */
export const RTL_TEST_LOCALE = {
  code: RTL_TEST_LOCALE_CODE,
  name: 'Arabic (RTL Test)',
  nativeName: 'العربية (اختبار)',
  language: 'ar',
  region: '',
  script: '',
  isRTL: true,
  strings: RTL_TEST_LOCALE_STRINGS
} as const

/**
 * Upserts `RTL_TEST_LOCALE` into `locales` on whatever Drizzle `db` handle it is given -- the same
 * `onConflictDoUpdate` shape `models/locales.ts#refreshFromDisk` uses for a real locale, so re-running
 * this (e.g. after editing the strings above) updates the existing row instead of erroring on the
 * primary key.
 */
export async function seedRtlTestLocale(db: WikiDb): Promise<void> {
  await db
    .insert(localesTable)
    .values(RTL_TEST_LOCALE)
    .onConflictDoUpdate({
      target: localesTable.code,
      set: {
        name: RTL_TEST_LOCALE.name,
        nativeName: RTL_TEST_LOCALE.nativeName,
        isRTL: RTL_TEST_LOCALE.isRTL,
        strings: RTL_TEST_LOCALE.strings,
        updatedAt: sql`now()`
      }
    })
}

/** The synthetic non-RTL locale's own code -- see the file header for why `es` was picked. */
export const LTR_TEST_LOCALE_CODE = 'es'

/**
 * Hand-translated Spanish strings, keyed exactly like `locales/en.json`. Only what
 * `e2e/tests/rtl.spec.js`'s content-vs-interface-locale cases actually read -- unlike
 * `RTL_TEST_LOCALE_STRINGS`, this locale is never switched to via `LocaleSelectorMenu.vue` or
 * checked for translated chrome, so it does not need the same namespace breadth.
 */
export const LTR_TEST_LOCALE_STRINGS: Record<string, string> = {
  'common.sidebar.browse': 'Navegar',
  'common.actions.save': 'Guardar',
  'admin.adminArea': 'Área de administración'
}

/** The full row this script upserts for the non-RTL fixture -- see `RTL_TEST_LOCALE` above. */
export const LTR_TEST_LOCALE = {
  code: LTR_TEST_LOCALE_CODE,
  name: 'Spanish (LTR Test)',
  nativeName: 'Español (prueba)',
  language: 'es',
  region: '',
  script: '',
  isRTL: false,
  strings: LTR_TEST_LOCALE_STRINGS
} as const

/** Same upsert shape as `seedRtlTestLocale`, for `LTR_TEST_LOCALE`. */
export async function seedLtrTestLocale(db: WikiDb): Promise<void> {
  await db
    .insert(localesTable)
    .values(LTR_TEST_LOCALE)
    .onConflictDoUpdate({
      target: localesTable.code,
      set: {
        name: LTR_TEST_LOCALE.name,
        nativeName: LTR_TEST_LOCALE.nativeName,
        isRTL: LTR_TEST_LOCALE.isRTL,
        strings: LTR_TEST_LOCALE.strings,
        updatedAt: sql`now()`
      }
    })
}

/**
 * Builds a throwaway connection from `DATABASE_URL`, runs `seed` against it, and closes it again --
 * the whole "I have no `db` handle of my own" case, shared by both `runSeed*TestLocale` functions
 * below. Used by the CLI entry point below, and by `e2e/tests/rtl.spec.js`: the e2e workspace has no
 * `pg`/`drizzle-orm` of its own (see that spec's header comment), so it calls these rather than
 * building a connection itself, and everything this function imports resolves against `backend/`'s
 * `node_modules` regardless of which workspace the caller lives in -- Node resolves bare specifiers
 * from the *importing file's own* location, not the process's cwd.
 *
 * The connection's `search_path` is set to `DB_SCHEMA` (default `'wiki'`, matching `base.yml`'s own
 * default and `core/db.ts`'s `-c search_path=...` pool option) rather than left to whatever the
 * server default is -- without it this would insert into `public`, where a real boot's tables never
 * live, and fail with "relation locales does not exist" against any database actually seeded by
 * `node backend`.
 *
 * @throws If `DATABASE_URL` is unset.
 */
async function withSeedDb(seed: (db: WikiDb) => Promise<void>): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Point it at the database to seed, e.g.:\n\n' +
        '  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres ' +
        'node backend/scripts/seed-rtl-test-locale.ts'
    )
  }

  const schema = process.env.DB_SCHEMA || 'wiki'
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`
  })
  try {
    const db = drizzle({ client: pool, relations }) as WikiDb
    await seed(db)
  } finally {
    await pool.end()
  }
}

/** @throws If `DATABASE_URL` is unset -- see `withSeedDb`. */
export async function runSeedRtlTestLocale(): Promise<void> {
  await withSeedDb(seedRtlTestLocale)
}

/** @throws If `DATABASE_URL` is unset -- see `withSeedDb`. */
export async function runSeedLtrTestLocale(): Promise<void> {
  await withSeedDb(seedLtrTestLocale)
}

/**
 * CLI entry point: guarded so importing this module (from a test, or from the e2e suite) never opens
 * a connection as a side effect -- only running the file directly does. Seeds both fixtures, each
 * over its own connection (`withSeedDb` opens and closes one per call) run concurrently.
 */
if (import.meta.main) {
  Promise.all([runSeedRtlTestLocale(), runSeedLtrTestLocale()])
    .then(() => {
      console.log(
        `Seeded RTL test locale '${RTL_TEST_LOCALE_CODE}' and LTR test locale '${LTR_TEST_LOCALE_CODE}' [ OK ]`
      )
    })
    .catch((err: any) => {
      console.error('Failed to seed test locales:', err.message)
      process.exitCode = 1
    })
}
