import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { userAvatars as userAvatarsTable, users as usersTable } from '../db/schema.ts'

/**
 * One schema for the whole file rather than one per describe (TEST-F14): every `setupTestDb()` call
 * is a `CREATE SCHEMA`, the full migration set and a seed, and each describe below wants the same
 * fixture. Anything a describe needs on top of that stays in its own `before()`.
 *
 * The `hasTestDatabase()` guard below is what a per-describe `{ skip }` cannot do for a FILE-level
 * hook: `describe(..., { skip })` skips the describe's own hooks and tests, but a root `before()`
 * runs regardless, so without this an unset `DATABASE_URL` would report every describe skipped AND
 * still throw out of the hook. Same shape as `models/contentSync.test.ts`'s own file-level fixture.
 */
let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
  // -> Both locale describes below want these installed; seeded once here rather than by each of
  //    them, which now share the one schema.
  await seedLocale(fixtures.db, { code: 'en' })
  await seedLocale(fixtures.db, { code: 'fr' })
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

/**
 * `updateProfile` is the write path for the profile screen's preferences, `users.prefs.locale`
 * (OpenProject #1619) included -- exercised DB-backed since it round-trips through `getById()` /
 * `updateUser()`, and `locale` validation reads the installed locale list through
 * `WIKI.models.locales.getLocales()`.
 */
describe('users.updateProfile (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
  })

  test('persists a locale naming an installed locale, and reads it back on reload', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })
    assert.equal(updated?.locale, 'fr')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, 'fr')
  })

  test('clears the preference on an empty string, without requiring it be installed', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    const cleared = await usersModel.updateProfile(fixtures.userId, { locale: '' })
    assert.equal(cleared?.locale, '')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, '')
  })

  test('rejects a locale code that names no installed locale, leaving the stored preference untouched', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    await assert.rejects(
      () => usersModel.updateProfile(fixtures.userId, { locale: 'xx-nonexistent' }),
      /ERR_INVALID_LOCALE/
    )

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, 'fr')
  })

  test('leaves other prefs/meta fields untouched when only the locale changes', async () => {
    await usersModel.updateProfile(fixtures.userId, { timezone: 'America/New_York', cvd: 'none' })

    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    assert.equal(updated?.locale, 'fr')
    assert.equal(updated?.timezone, 'America/New_York')
  })
})

/**
 * #1619/#1611: `users.prefs` gains a `locale` entry, validated against the installed locale
 * catalogue on write — the preference `models/mail.ts`'s server-side string resolver (#1623) reads
 * to address a recipient in their own language rather than always `en`.
 */
describe('users.updateProfile locale preference (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
  })

  test('persists a known locale and reads it back on the profile', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })
    assert.equal(updated?.locale, 'fr')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, 'fr')
  })

  test('clears the preference when set to an empty string', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    const cleared = await usersModel.updateProfile(fixtures.userId, { locale: '' })
    assert.equal(cleared?.locale, '')
  })

  test('rejects a locale code the instance does not have installed', async () => {
    await assert.rejects(
      () => usersModel.updateProfile(fixtures.userId, { locale: 'xx-not-installed' }),
      /ERR_INVALID_LOCALE/
    )
  })

  test('a locale-only update leaves other preferences untouched', async () => {
    await usersModel.updateProfile(fixtures.userId, { appearance: 'dark', cvd: 'protanopia' })

    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'en' })

    assert.equal(updated?.locale, 'en')
    assert.equal(updated?.appearance, 'dark')
    assert.equal(updated?.cvd, 'protanopia')
  })
})

/**
 * OpenProject #1849: `setAvatar` writes the sha1 of the exact (Sharp-normalized-or-not) bytes it
 * stores, and `getAvatarHash` reads it back without touching `data`. This round-trips the real write
 * path against a migrated database rather than re-describing its SQL.
 */
describe('users.setAvatar / getAvatarHash (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
  })

  test('getAvatarHash returns null for a user with no avatar', async () => {
    assert.equal(await usersModel.getAvatarHash(fixtures.userId), null)
  })

  test('setAvatar stores a hash equal to the sha1 of the bytes getAvatar later returns', async () => {
    await usersModel.setAvatar(fixtures.userId, Buffer.from('first-avatar-bytes'))

    const avatar = await usersModel.getAvatar(fixtures.userId)
    const hash = await usersModel.getAvatarHash(fixtures.userId)

    assert.ok(avatar)
    const expected = crypto.createHash('sha1').update(avatar!.data).digest('hex')
    assert.equal(hash, expected)
  })

  test('re-uploading different bytes changes the hash', async () => {
    await usersModel.setAvatar(fixtures.userId, Buffer.from('avatar-version-one'))
    const firstHash = await usersModel.getAvatarHash(fixtures.userId)

    await usersModel.setAvatar(fixtures.userId, Buffer.from('avatar-version-two-different'))
    const secondHash = await usersModel.getAvatarHash(fixtures.userId)

    assert.notEqual(firstHash, secondHash)
    const avatar = await usersModel.getAvatar(fixtures.userId)
    assert.equal(secondHash, crypto.createHash('sha1').update(avatar!.data).digest('hex'))
  })

  test('clearAvatar leaves getAvatarHash returning null again', async () => {
    await usersModel.setAvatar(fixtures.userId, Buffer.from('avatar-to-clear'))
    assert.ok(await usersModel.getAvatarHash(fixtures.userId), 'sanity: upload landed first')

    await usersModel.clearAvatar(fixtures.userId)

    assert.equal(await usersModel.getAvatarHash(fixtures.userId), null)
  })
})

/**
 * `userAvatars.id` carries an `onDelete: 'cascade'` foreign key to `users.id` (see `db/schema.ts`) —
 * an avatar dies with its user at the database layer, not merely through `deleteUser()` remembering
 * to clean it up. Deleting the `users` row directly, bypassing `deleteUser()` entirely, is what
 * actually exercises that the constraint (rather than app code) is what enforces it.
 */
/**
 * Feature #2425: `getNotificationSubscriptions` / `setNotificationSubscriptions`, the boolean-map
 * view of the per-user, per-event-type email opt-in `#2481` stores as `prefs.notifications.events`
 * (see `getEmailNotificationEvents`/`setEmailNotificationEvents`, which these two adapt). DB-backed
 * for the same reason `updateProfile` above is -- this round-trips through `getById()` /
 * `updateUser()`, not just a pure merge function.
 */
describe('users.notificationSubscriptions (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users
  let HOOK_EVENTS: typeof import('./hooks.ts').HOOK_EVENTS

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
    ;({ HOOK_EVENTS } = await import('./hooks.ts'))
  })

  test('defaults every known event to false for a user who has never set any', async () => {
    const subscriptions = await usersModel.getNotificationSubscriptions(fixtures.userId)
    assert.ok(subscriptions)
    assert.deepEqual(Object.keys(subscriptions!).sort(), [...HOOK_EVENTS].sort())
    for (const event of HOOK_EVENTS) {
      assert.equal(subscriptions![event], false)
    }
  })

  test('returns null for a user that does not exist', async () => {
    assert.equal(
      await usersModel.getNotificationSubscriptions('00000000-0000-4000-8000-000000000000'),
      null
    )
    assert.equal(
      await usersModel.setNotificationSubscriptions('00000000-0000-4000-8000-000000000000', {
        'page:create': true
      }),
      null
    )
  })

  test('setNotificationSubscriptions turns on only the events given, and persists across reload', async () => {
    const updated = await usersModel.setNotificationSubscriptions(fixtures.userId, {
      'page:create': true,
      'comment:new': true
    })
    assert.equal(updated?.['page:create'], true)
    assert.equal(updated?.['comment:new'], true)
    assert.equal(updated?.['page:edit'], false)

    const reloaded = await usersModel.getNotificationSubscriptions(fixtures.userId)
    assert.equal(reloaded?.['page:create'], true)
    assert.equal(reloaded?.['comment:new'], true)
    assert.equal(reloaded?.['page:edit'], false)
  })

  test('a later partial update leaves previously-set events untouched, and can turn one back off', async () => {
    await usersModel.setNotificationSubscriptions(fixtures.userId, {
      'page:create': true,
      'asset:upload': true
    })

    const updated = await usersModel.setNotificationSubscriptions(fixtures.userId, {
      'page:create': false,
      'user:login': true
    })

    assert.equal(updated?.['page:create'], false)
    assert.equal(updated?.['asset:upload'], true, 'untouched by this patch, stays as it was')
    assert.equal(updated?.['user:login'], true)
  })

  test('leaves other prefs fields (e.g. locale) untouched', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'en', timezone: 'America/New_York' })

    await usersModel.setNotificationSubscriptions(fixtures.userId, { 'page:delete': true })

    const profile = await usersModel.getProfile(fixtures.userId)
    assert.equal(profile?.locale, 'en')
    assert.equal(profile?.timezone, 'America/New_York')
  })
})

describe('userAvatars cascades from users (DB-backed)', { skip: !hasTestDatabase() }, () => {
  test('removes the avatar when the users row is deleted directly, without calling deleteUser()', async () => {
    const [avatarOwner] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'avatar-owner@example.com',
        name: 'Avatar Owner',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    const userId = avatarOwner!.id

    // -> Inserted directly rather than via `setAvatar()`: this suite is about the FK's own
    //    `onDelete: 'cascade'`, not the avatar-normalization path, so it needs no real image bytes.
    await fixtures.db
      .insert(userAvatarsTable)
      .values({ id: userId, data: Buffer.from('avatar-bytes'), hash: 'avatar-bytes-hash' })
    const beforeDelete = await fixtures.db
      .select()
      .from(userAvatarsTable)
      .where(eq(userAvatarsTable.id, userId))
    assert.equal(beforeDelete.length, 1)

    // -> Direct row delete, not `deleteUser()`: this is what proves the FK's own `onDelete: 'cascade'`
    //    is doing the work, rather than an app-level call site that happens to also clear the avatar.
    await fixtures.db.delete(usersTable).where(eq(usersTable.id, userId))

    const afterDelete = await fixtures.db
      .select()
      .from(userAvatarsTable)
      .where(eq(userAvatarsTable.id, userId))
    assert.equal(afterDelete.length, 0)
  })
})
