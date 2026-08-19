/**
 * One-off seed for a synthetic RTL locale, for validating feature 413 ("RTL support end-to-end")
 * against a real right-to-left locale end to end.
 *
 * There is no real RTL locale available anywhere in this fork: `locales/metadata.js` is
 * Localazy-generated output covering only de/en/fr/pt-BR/ru/zh (see its own header comment), and
 * only `locales/en.json` exists on disk. Getting real Arabic or Hebrew strings requires enabling
 * those languages on the Localazy project and re-running the download -- an external/ops dependency
 * outside this feature's engineering scope (see `docs/variances.md`).
 *
 * This script inserts a hand-translated stand-in directly into the `locales` table instead: enough
 * real Arabic strings across the namespaces the reading view, editor toolbars and admin chrome
 * actually read from (`common.*`, `editor.markup.*`, `admin.*`, `auth.*`, `welcome.*`) to exercise
 * the whole rendering path with `isRTL: true` genuinely in effect, per `models/locales.ts`'s
 * `getLocales()`/`getStrings()`. Deliberately NOT wired into `metadata.js`/`refreshFromDisk()`: that
 * pipeline is Localazy's real-locale path, and `refreshFromDisk()` only ever touches codes present in
 * `metadata.js`'s `languages` list, so this row is invisible to it and never gets overwritten by a
 * normal boot.
 *
 * Two ways to run it:
 *   - `import { seedRtlTestLocale, RTL_TEST_LOCALE } from './seed-rtl-test-locale.ts'` from a script
 *     or test that already has a Drizzle `db` handle (e.g. `test/db.ts`'s `setupTestDb()`).
 *   - `node backend/scripts/seed-rtl-test-locale.ts` (from the repo root, or anywhere -- it builds
 *     its own connection from `DATABASE_URL` and does not depend on `WIKI` or `cwd`), which upserts
 *     into whichever database `DATABASE_URL` names and exits.
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
  'welcome.title': 'مرحباً بك في Wiki.js!',
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

/**
 * Builds its own throwaway connection from `DATABASE_URL`, seeds, and closes it again -- the whole
 * "I have no `db` handle of my own" case. Used by the CLI entry point below, and by
 * `e2e/tests/rtl.spec.js`: the e2e workspace has no `pg`/`drizzle-orm` of its own (see that spec's
 * header comment), so it calls this rather than building a connection itself, and everything this
 * function imports resolves against `backend/`'s `node_modules` regardless of which workspace the
 * caller lives in -- Node resolves bare specifiers from the *importing file's own* location, not the
 * process's cwd.
 *
 * The connection's `search_path` is set to `DB_SCHEMA` (default `'wiki'`, matching `base.yml`'s own
 * default and `core/db.ts`'s `-c search_path=...` pool option) rather than left to whatever the
 * server default is -- without it this would insert into `public`, where a real boot's tables never
 * live, and fail with "relation locales does not exist" against any database actually seeded by
 * `node backend`.
 *
 * @throws If `DATABASE_URL` is unset.
 */
export async function runSeedRtlTestLocale(): Promise<void> {
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
    await seedRtlTestLocale(db)
  } finally {
    await pool.end()
  }
}

/**
 * CLI entry point: guarded so importing this module (from a test, or from the e2e suite) never opens
 * a connection as a side effect -- only running the file directly does.
 */
if (import.meta.main) {
  runSeedRtlTestLocale()
    .then(() => {
      console.log(`Seeded RTL test locale '${RTL_TEST_LOCALE_CODE}' [ OK ]`)
    })
    .catch((err: any) => {
      console.error('Failed to seed RTL test locale:', err.message)
      process.exitCode = 1
    })
}
