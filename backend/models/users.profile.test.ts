import { after, before, beforeEach, describe, test } from 'node:test'
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
 * The `hasTestDatabase()` guard below is what a per-describe `{ skip }` cannot do for a FILE-level
 * hook: `describe(..., { skip })` skips the describe's own hooks and tests, but a root `before()`
 * runs regardless, so without it an unset `DATABASE_URL` still throws out of the hook.
 */
let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
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
 * `locale` validation reads the installed locale list through `CARDINAL.models.locales.getLocales()`,
 * which is why the file-level fixture seeds `en` and `fr`.
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

  test("defaults aesthetic to 'site' for a user who has never set one", async () => {
    const profile = await usersModel.getProfile(fixtures.userId)
    assert.equal(profile?.aesthetic, 'site')
  })

  test('persists an aesthetic preference and reads it back on reload', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { aesthetic: 'cobalt' })
    assert.equal(updated?.aesthetic, 'cobalt')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.aesthetic, 'cobalt')
  })

  /** `'site'` is a deferral to the site's own admin setting, resolved on the frontend, not a width. */
  test("defaults contentWidth to 'site' for a user who has never set one", async () => {
    const profile = await usersModel.getProfile(fixtures.userId)
    assert.equal(profile?.contentWidth, 'site')
  })

  test('persists a contentWidth preference and reads it back on reload', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { contentWidth: 'measured' })
    assert.equal(updated?.contentWidth, 'measured')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.contentWidth, 'measured')
  })

  test('leaves contentWidth untouched when only aesthetic changes, and vice versa', async () => {
    await usersModel.updateProfile(fixtures.userId, { contentWidth: 'full' })
    const updated = await usersModel.updateProfile(fixtures.userId, { aesthetic: 'cobalt' })

    assert.equal(updated?.aesthetic, 'cobalt')
    assert.equal(updated?.contentWidth, 'full')
  })

  /**
   * Unlike the flat prefs fields above, `graph` gets no forced default from the model — the frontend
   * alone decides what an unset control falls back to, so an unsaved preference reads as absent.
   */
  test('has no graph key at all for a user who has never saved one', async () => {
    const profile = await usersModel.getProfile(fixtures.userId)
    assert.equal(profile?.graph, undefined)
  })

  test('persists a graph preference and reads it back on reload', async () => {
    const graph = {
      groupBy: 'tag',
      sizeBy: 'visits',
      count: 'unique',
      over: 'last6mo',
      clientTypes: ['browser', 'mcp']
    }

    const updated = await usersModel.updateProfile(fixtures.userId, { graph })
    assert.deepEqual(updated?.graph, graph)

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.deepEqual(reloaded?.graph, graph)
  })

  test('a later save replaces the whole graph object rather than merging into it', async () => {
    await usersModel.updateProfile(fixtures.userId, {
      graph: { groupBy: 'tag', sizeBy: 'visits' }
    })

    const updated = await usersModel.updateProfile(fixtures.userId, {
      graph: { groupBy: 'folder' }
    })

    assert.deepEqual(updated?.graph, { groupBy: 'folder' })
  })

  test('leaves other prefs fields (e.g. locale) untouched when only graph changes', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    const updated = await usersModel.updateProfile(fixtures.userId, { graph: { groupBy: 'tag' } })

    assert.deepEqual(updated?.graph, { groupBy: 'tag' })
    assert.equal(updated?.locale, 'fr')
  })

  test('leaves a saved graph preference untouched when an unrelated field changes', async () => {
    await usersModel.updateProfile(fixtures.userId, { graph: { groupBy: 'tag' } })

    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    assert.deepEqual(updated?.graph, { groupBy: 'tag' })
  })

  test('has no iconPicker key at all for a user who has never saved one', async () => {
    const profile = await usersModel.getProfile(fixtures.userId)
    assert.equal(profile?.iconPicker, undefined)
  })

  test('persists an iconPicker preference and reads it back on reload', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { iconPicker: { set: 'mdi' } })
    assert.deepEqual(updated?.iconPicker, { set: 'mdi' })

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.deepEqual(reloaded?.iconPicker, { set: 'mdi' })
  })

  test('leaves other prefs fields (e.g. graph) untouched when only iconPicker changes', async () => {
    await usersModel.updateProfile(fixtures.userId, { graph: { groupBy: 'tag' } })

    const updated = await usersModel.updateProfile(fixtures.userId, {
      iconPicker: { set: 'mdi' }
    })

    assert.deepEqual(updated?.iconPicker, { set: 'mdi' })
    assert.deepEqual(updated?.graph, { groupBy: 'tag' })
  })
})

describe('users.updateProfile name halves (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
  })

  /*
    These tests share the file's one fixture user, and one of them authors the display name -- a
    state that by design survives every later write. Submitting a `name` equal to what the halves
    derive to is the model's own way back onto derivation, not a test-only backdoor.
  */
  beforeEach(async () => {
    await usersModel.updateProfile(fixtures.userId, {
      name: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
  })

  test('re-derives the display name from the two halves when no name is submitted', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, {
      firstName: 'Ada',
      lastName: 'Lovelace'
    })

    assert.equal(updated?.firstName, 'Ada')
    assert.equal(updated?.lastName, 'Lovelace')
    assert.equal(updated?.name, 'Ada Lovelace')
  })

  test('a submitted name matching what the halves derive to keeps the account on derivation', async () => {
    await usersModel.updateProfile(fixtures.userId, { firstName: 'Ada', lastName: 'Lovelace' })

    // -> What the profile form submits on every save. Because it equals the derived value, the row
    //    is NOT marked authored -- so the next half-only edit still moves the display name.
    await usersModel.updateProfile(fixtures.userId, {
      name: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace'
    })

    const afterHalfEdit = await usersModel.updateProfile(fixtures.userId, { firstName: 'Augusta' })
    assert.equal(afterHalfEdit?.name, 'Augusta Lovelace')
  })

  test('an explicitly different display name is authored, and survives a later half edit', async () => {
    await usersModel.updateProfile(fixtures.userId, { firstName: 'Ada', lastName: 'Lovelace' })

    const authored = await usersModel.updateProfile(fixtures.userId, {
      name: 'Countess Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
    assert.equal(authored?.name, 'Countess Lovelace')

    const afterHalfEdit = await usersModel.updateProfile(fixtures.userId, { firstName: 'Augusta' })
    assert.equal(afterHalfEdit?.firstName, 'Augusta')
    assert.equal(afterHalfEdit?.name, 'Countess Lovelace')
  })

  test('a mononym derives its display name from the first name alone', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, {
      firstName: 'Prince',
      lastName: ''
    })

    assert.equal(updated?.lastName, '')
    assert.equal(updated?.name, 'Prince')
  })

  test('a save touching no name field leaves all three alone', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { jobTitle: 'Analyst' })

    assert.equal(updated?.jobTitle, 'Analyst')
    assert.equal(updated?.name, 'Ada Lovelace')
    assert.equal(updated?.firstName, 'Ada')
    assert.equal(updated?.lastName, 'Lovelace')
  })
})

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
 * The stored hash is of the bytes as written, which Sharp may have normalized — hence hashing what
 * `getAvatar()` hands back rather than the buffer passed to `setAvatar()`.
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
 * The `beforeEach` reset is needed because this describe shares the file's one fixture user with
 * every other; nothing on the model clears `avatarProviderUrl`, hence the direct update.
 */
describe('users.syncAvatarFromProvider (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
  })

  beforeEach(async () => {
    await usersModel.clearAvatar(fixtures.userId)
    await fixtures.db
      .update(usersTable)
      .set({ avatarProviderUrl: null })
      .where(eq(usersTable.id, fixtures.userId))
  })

  async function readAvatarProviderUrl(): Promise<string | null> {
    const rows = await fixtures.db
      .select({ avatarProviderUrl: usersTable.avatarProviderUrl })
      .from(usersTable)
      .where(eq(usersTable.id, fixtures.userId))
      .limit(1)
    return rows[0]?.avatarProviderUrl ?? null
  }

  test('applies when the user has no manually-uploaded avatar', async () => {
    const applied = await usersModel.syncAvatarFromProvider(
      fixtures.userId,
      'https://provider.example/photo.jpg'
    )

    assert.equal(applied, true)
    assert.equal(await readAvatarProviderUrl(), 'https://provider.example/photo.jpg')
  })

  test('is a no-op when a manual avatar already exists, and never overwrites it', async () => {
    await usersModel.setAvatar(fixtures.userId, Buffer.from('manual-avatar-bytes'))

    const applied = await usersModel.syncAvatarFromProvider(
      fixtures.userId,
      'https://provider.example/should-not-land.jpg'
    )

    assert.equal(applied, false)
    assert.equal(await readAvatarProviderUrl(), null)
  })

  test('a later manual upload does not retroactively clear an already-cached provider URL', async () => {
    // -> `setAvatar` governs only `hasAvatar` and the blob it owns, leaving `avatarProviderUrl`
    //    deliberately stale: `hasAvatar` is what a renderer checks first for the manual avatar to win.
    await usersModel.syncAvatarFromProvider(fixtures.userId, 'https://provider.example/photo.jpg')
    await usersModel.setAvatar(fixtures.userId, Buffer.from('manual-avatar-bytes'))

    assert.equal(await readAvatarProviderUrl(), 'https://provider.example/photo.jpg')
  })

  test('is a no-op for an empty or whitespace-only URL', async () => {
    assert.equal(await usersModel.syncAvatarFromProvider(fixtures.userId, ''), false)
    assert.equal(await usersModel.syncAvatarFromProvider(fixtures.userId, '   '), false)
    assert.equal(await usersModel.syncAvatarFromProvider(fixtures.userId, null), false)
    assert.equal(await usersModel.syncAvatarFromProvider(fixtures.userId, undefined), false)
    assert.equal(await readAvatarProviderUrl(), null)
  })

  test('returns false for an unknown user id, rather than throwing', async () => {
    const applied = await usersModel.syncAvatarFromProvider(
      '00000000-0000-0000-0000-000000000000',
      'https://provider.example/photo.jpg'
    )

    assert.equal(applied, false)
  })

  test('surfaces through getProfile() once synced', async () => {
    await usersModel.syncAvatarFromProvider(fixtures.userId, 'https://provider.example/photo.jpg')

    const profile = await usersModel.getProfile(fixtures.userId)

    assert.equal(profile?.avatarProviderUrl, 'https://provider.example/photo.jpg')
  })

  test('getProfile() reports null when nothing has ever been synced', async () => {
    const profile = await usersModel.getProfile(fixtures.userId)

    assert.equal(profile?.avatarProviderUrl, null)
  })
})

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

    await fixtures.db
      .insert(userAvatarsTable)
      .values({ id: userId, data: Buffer.from('avatar-bytes'), hash: 'avatar-bytes-hash' })
    const beforeDelete = await fixtures.db
      .select()
      .from(userAvatarsTable)
      .where(eq(userAvatarsTable.id, userId))
    assert.equal(beforeDelete.length, 1)

    // -> The direct delete is the point: it proves `userAvatars.id`'s own `onDelete: 'cascade'` does
    //    the work, not an app-level call site that happens to also clear the avatar.
    await fixtures.db.delete(usersTable).where(eq(usersTable.id, userId))

    const afterDelete = await fixtures.db
      .select()
      .from(userAvatarsTable)
      .where(eq(userAvatarsTable.id, userId))
    assert.equal(afterDelete.length, 0)
  })
})
