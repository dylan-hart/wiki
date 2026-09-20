/* eslint-disable no-console -- a one-off seeding script: its stdout IS its result, and it runs outside a booted `CARDINAL`. */
/**
 * Seeds two synthetic locales, as fixtures for exercising RTL rendering and the content-vs-interface
 * locale split end to end.
 *
 * `ar` and `es` are real locales `models/locales.ts#refreshFromDisk()` owns and resyncs on every
 * boot, and are reused anyway rather than picked around: that upsert's `setWhere` freshness guard
 * only ever overwrites a row whose current `updatedAt` is older than the vendored file's mtime, and
 * this seed always writes `now()`, so no boot can clobber it however the two interleave.
 *
 *   - `RTL_TEST_LOCALE` (`ar`, `isRTL: true`) -- hand-translated rather than the real,
 *     Localazy-sourced `ar.json`, whose completeness is whatever fraction of the catalog the
 *     crowd-sourced project has translated at any given moment: an unpredictable, shifting subset of
 *     keys is unusable as a fixture an e2e spec asserts specific translated strings against.
 *   - `LTR_TEST_LOCALE` (`es`, `isRTL: false`) -- a non-right-to-left second locale, so a spec can
 *     assert `<html lang>` follows a page's own content locale even when that locale is not RTL.
 *
 * Either import `seedRtlTestLocale`/`RTL_TEST_LOCALE` (or the `Ltr`-prefixed equivalents) where a
 * Drizzle `db` handle already exists, or run `node backend/scripts/seed-rtl-test-locale.ts`, which
 * builds its own connections from `DATABASE_URL` and depends on neither `CARDINAL` nor `cwd`.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { locales as localesTable } from '../db/schema.ts'
import { relations } from '../db/relations.ts'
import type { WikiDb } from '../core/db.ts'

/** Chosen over `he` because CLDR's `Intl.Locale('ar').textInfo.direction` is `'rtl'`, which is what
 *  `frontend/src/stores/site.js`'s `describeLocales()` resolves `isRTL` from. */
export const RTL_TEST_LOCALE_CODE = 'ar'

/**
 * Keyed exactly like `locales/en.json` -- flat dot-paths, not nested objects. Not a translation of
 * the whole catalog: just enough for the reading view, the page chrome, the Markdown editor's
 * toolbar and the admin area to have something real to render.
 *
 * `editor.markup.*` is the Markdown editor's toolbar alone. `EditorWysiwyg.vue` has no i18n wiring
 * at all (its `title:` labels are hardcoded English passed straight to `aria-label`, never through
 * `t()`), so nothing seeded here changes what that editor renders.
 */
export const RTL_TEST_LOCALE_STRINGS: Record<string, string> = {
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
  'admin.adminArea': 'منطقة الإدارة',
  'admin.locale.title': 'اللغة',
  'admin.locale.subtitle': 'إعدادات التعريب لهذا الموقع',
  'admin.locale.settings': 'الإعدادات',
  'admin.locale.primary': 'اللغة الأساسية',
  'admin.locale.active': 'اللغات المفعّلة',
  'admin.locale.saveSuccess': 'تم حفظ إعدادات اللغة بنجاح.',
  'admin.locale.loadFailed': 'فشل تحميل إعدادات اللغة.',
  'auth.actions.login': 'تسجيل الدخول',
  'auth.enterCredentials': 'أدخل بيانات الاعتماد الخاصة بك',
  'welcome.title': 'مرحباً بك في Cardinal.js!',
  'welcome.subtitle': 'لنبدأ...'
}

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

/** An upsert, so re-running after editing the strings above updates the existing row rather than
 *  erroring on the primary key. */
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

export const LTR_TEST_LOCALE_CODE = 'es'

/**
 * Only what the content-vs-interface-locale cases read: unlike `RTL_TEST_LOCALE_STRINGS`, this
 * locale is never switched to and never checked for translated chrome, so it needs no breadth.
 */
export const LTR_TEST_LOCALE_STRINGS: Record<string, string> = {
  'common.sidebar.browse': 'Navegar',
  'common.actions.save': 'Guardar',
  'admin.adminArea': 'Área de administración'
}

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
 * Also called from the e2e workspace, which has no `pg`/`drizzle-orm` of its own: Node resolves bare
 * specifiers from the *importing file's own* location rather than the process's cwd, so everything
 * imported here loads out of `backend/`'s `node_modules` whichever workspace the caller lives in.
 *
 * `search_path` is pinned to `DB_SCHEMA` (default `'wiki'`, matching `base.yml` and `core/db.ts`'s
 * pool option) rather than left to the server default -- without it the insert lands in `public`,
 * where a real boot's tables never live, and fails with "relation locales does not exist".
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

export async function runSeedRtlTestLocale(): Promise<void> {
  await withSeedDb(seedRtlTestLocale)
}

export async function runSeedLtrTestLocale(): Promise<void> {
  await withSeedDb(seedLtrTestLocale)
}

// -> Guarded so importing this module (from a test, or from the e2e suite) never opens a connection
//    as a side effect.
if (import.meta.main) {
  Promise.all([runSeedRtlTestLocale(), runSeedLtrTestLocale()])
    .then(() => {
      console.log(
        `Seeded RTL test locale '${RTL_TEST_LOCALE_CODE}' and LTR test locale '${LTR_TEST_LOCALE_CODE}'`
      )
    })
    .catch((err: any) => {
      console.error('Failed to seed test locales:', err.message)
      process.exitCode = 1
    })
}
