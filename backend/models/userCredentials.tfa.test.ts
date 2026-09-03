import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { userCredentials } from './userCredentials.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { users as usersTable } from '../db/schema.ts'
import type { RecoveryCodeEntry } from './userCredentials.ts'
import { ensureTemporal } from '../test/temporal.ts'

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
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

/**
 * `enableTfa`/`verifyAndConsumeRecoveryCode`/`regenerateRecoveryCodes`/`getRecoveryCodesStatus` are
 * thin persistence wrappers around `issueRecoveryCodes()` and `matchRecoveryCode()` (both covered
 * above without a database) — but the wrapping itself, a JSONB `auth` blob round-tripping through a
 * real update/select, is exactly the kind of thing a query-builder mock would just be re-describing.
 * This suite runs the real methods against a migrated, per-run-fresh database (see `test/db.ts`).
 */
describe('userCredentials recovery codes (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
    await ensureTemporal()
  })

  /** A fresh, otherwise-unused strategy key each test can enable/consume/regenerate against. */
  function freshStrategyId(): string {
    return `strategy-${Math.random().toString(36).slice(2)}`
  }

  test('enableTfa issues RECOVERY_CODE_COUNT distinct codes and stores only their hashes', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    const recoveryCodes = await userCredentials.enableTfa(user, strategyId)

    assert.equal(recoveryCodes.length, 10)
    assert.equal(new Set(recoveryCodes).size, 10)

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    const entries = reloaded.auth[strategyId].recoveryCodes as RecoveryCodeEntry[]
    assert.equal(entries.length, 10)
    for (const entry of entries) {
      assert.equal(entry.usedAt, null)
      assert.ok(!recoveryCodes.includes(entry.hash))
    }
  })

  test('verifyAndConsumeRecoveryCode accepts an issued code once, then rejects it on a second try', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const [code] = await userCredentials.enableTfa(owner, strategyId)

    const firstAttempt = await usersModel.getById(fixtures.userId)
    assert.equal(
      await userCredentials.verifyAndConsumeRecoveryCode(firstAttempt, strategyId, code!),
      true
    )

    const secondAttempt = await usersModel.getById(fixtures.userId)
    assert.equal(
      await userCredentials.verifyAndConsumeRecoveryCode(secondAttempt, strategyId, code!),
      false
    )
  })

  test('two concurrent verifyAndConsumeRecoveryCode calls for the same code redeem exactly one entry', async () => {
    // -> Distinct from the sequential single-use test above, which re-reads the user between
    //    attempts and so exercises only the serialized case: this fires both attempts at once, off
    //    two separately-loaded copies of the same row, to prove the advisory lock -- not just
    //    request ordering -- is what prevents a double-spend.
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const [code] = await userCredentials.enableTfa(owner, strategyId)

    const [attemptA, attemptB] = await Promise.all([
      usersModel.getById(fixtures.userId),
      usersModel.getById(fixtures.userId)
    ])

    const [resultA, resultB] = await Promise.all([
      userCredentials.verifyAndConsumeRecoveryCode(attemptA, strategyId, code!),
      userCredentials.verifyAndConsumeRecoveryCode(attemptB, strategyId, code!)
    ])

    assert.equal([resultA, resultB].filter(Boolean).length, 1, 'exactly one attempt should redeem')

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    const entries = reloaded.auth[strategyId].recoveryCodes as RecoveryCodeEntry[]
    assert.equal(entries.filter((entry) => entry.usedAt).length, 1)
  })

  test('verifyAndConsumeRecoveryCode rejects a code that was never issued', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    await userCredentials.enableTfa(owner, strategyId)

    const user = await usersModel.getById(fixtures.userId)
    assert.equal(
      await userCredentials.verifyAndConsumeRecoveryCode(user, strategyId, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ'),
      false
    )
  })

  test('verifyTfaCode refuses a code on a second presentation, while the next window is still accepted', async () => {
    const strategyId = freshStrategyId()
    // -> RFC 6238 Appendix B's SHA-1 test vector (same secret `helpers/totp.test.ts` uses): at
    //    Time=59s (counter 1) the code is 287082; the next 30s window (counter 2) is 359152.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const owner = (await usersModel.getById(fixtures.userId)) as any
    owner.auth[strategyId] = { tfaSecret: secret, tfaIsActive: true }
    await fixtures.db
      .update(usersTable)
      .set({ auth: owner.auth })
      .where(eq(usersTable.id, fixtures.userId))

    mock.timers.enable({ apis: ['Date'], now: 59_000 })
    try {
      const firstAttempt = await usersModel.getById(fixtures.userId)
      assert.equal(await userCredentials.verifyTfaCode(firstAttempt, strategyId, '287082'), true)

      // -> Same code, presented again inside the same ±30s drift window: refused, since its counter
      //    was already recorded as `tfaLastCounter` by the accepted attempt above.
      const replayAttempt = await usersModel.getById(fixtures.userId)
      assert.equal(await userCredentials.verifyTfaCode(replayAttempt, strategyId, '287082'), false)

      // -> A different code from the next window is not a replay of the same counter, so it is still
      //    accepted -- single-use blocks the matched counter, not the whole secret.
      const nextWindowAttempt = await usersModel.getById(fixtures.userId)
      assert.equal(
        await userCredentials.verifyTfaCode(nextWindowAttempt, strategyId, '359152'),
        true
      )
    } finally {
      mock.timers.reset()
    }
  })

  test('verifyTfaCode persists the matched counter so it survives a reload, not just in-process', async () => {
    const strategyId = freshStrategyId()
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const owner = (await usersModel.getById(fixtures.userId)) as any
    owner.auth[strategyId] = { tfaSecret: secret, tfaIsActive: true }
    await fixtures.db
      .update(usersTable)
      .set({ auth: owner.auth })
      .where(eq(usersTable.id, fixtures.userId))

    mock.timers.enable({ apis: ['Date'], now: 59_000 })
    try {
      const attempt = await usersModel.getById(fixtures.userId)
      assert.equal(await userCredentials.verifyTfaCode(attempt, strategyId, '287082'), true)

      const reloaded = (await usersModel.getById(fixtures.userId)) as any
      assert.equal(reloaded.auth[strategyId].tfaLastCounter, 1)
    } finally {
      mock.timers.reset()
    }
  })

  test('getRecoveryCodesStatus reports total/remaining and drops by one per consumed code', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const codes = await userCredentials.enableTfa(owner, strategyId)

    const before = await userCredentials.getRecoveryCodesStatus(fixtures.userId, strategyId)
    assert.deepEqual(before, { total: 10, remaining: 10 })

    const consumer = await usersModel.getById(fixtures.userId)
    await userCredentials.verifyAndConsumeRecoveryCode(consumer, strategyId, codes[0]!)

    const after = await userCredentials.getRecoveryCodesStatus(fixtures.userId, strategyId)
    assert.deepEqual(after, { total: 10, remaining: 9 })
  })

  test('getRecoveryCodesStatus throws ERR_INVALID_STRATEGY for a strategy the user has no entry for', async () => {
    await assert.rejects(
      userCredentials.getRecoveryCodesStatus(fixtures.userId, freshStrategyId()),
      /ERR_INVALID_STRATEGY/
    )
  })

  test('getRecoveryCodesStatus throws ERR_TFA_NOT_ACTIVE for a secret that was generated but never activated', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    await userCredentials.startTfaSetup(user, strategyId, fixtures.siteId)

    await assert.rejects(
      userCredentials.getRecoveryCodesStatus(fixtures.userId, strategyId),
      /ERR_TFA_NOT_ACTIVE/
    )
  })

  test('regenerateRecoveryCodes replaces the whole set and reports whether unused codes were thrown away', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const original = await userCredentials.enableTfa(owner, strategyId)

    const { recoveryCodes: fresh, hadUnusedCodes } = await userCredentials.regenerateRecoveryCodes(
      fixtures.userId,
      strategyId
    )
    assert.equal(hadUnusedCodes, true)
    assert.equal(fresh.length, 10)
    assert.equal(
      fresh.some((code) => original.includes(code)),
      false
    )

    // -> A code from the set that was just replaced no longer works, even though it was never used.
    const user = await usersModel.getById(fixtures.userId)
    assert.equal(
      await userCredentials.verifyAndConsumeRecoveryCode(user, strategyId, original[0]!),
      false
    )
  })

  test('regenerateRecoveryCodes reports hadUnusedCodes false once every prior code was already spent', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const codes = await userCredentials.enableTfa(owner, strategyId)
    // -> Every issued code gets consumed one by one, since each attempt needs a freshly-reloaded user.
    for (const code of codes) {
      const consumer = await usersModel.getById(fixtures.userId)
      assert.equal(
        await userCredentials.verifyAndConsumeRecoveryCode(consumer, strategyId, code),
        true
      )
    }

    const { hadUnusedCodes } = await userCredentials.regenerateRecoveryCodes(
      fixtures.userId,
      strategyId
    )
    assert.equal(hadUnusedCodes, false)
  })

  test('regenerateRecoveryCodes throws ERR_TFA_NOT_ACTIVE for a secret that was generated but never activated', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    await userCredentials.startTfaSetup(user, strategyId, fixtures.siteId)

    await assert.rejects(
      userCredentials.regenerateRecoveryCodes(fixtures.userId, strategyId),
      /ERR_TFA_NOT_ACTIVE/
    )
  })

  test('disableTfa clears recovery codes, so a code from the old set never works after 2FA is re-enabled', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const [oldCode] = await userCredentials.enableTfa(owner, strategyId)

    await userCredentials.disableTfa(fixtures.userId, strategyId)

    const reEnabled = await usersModel.getById(fixtures.userId)
    await userCredentials.enableTfa(reEnabled, strategyId)

    const user = await usersModel.getById(fixtures.userId)
    assert.equal(
      await userCredentials.verifyAndConsumeRecoveryCode(user, strategyId, oldCode!),
      false
    )
  })

  test('adminInvalidateTfa clears the secret, deactivates 2FA, and drops recovery codes even when tfaRequired is set', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    await userCredentials.enableTfa(owner, strategyId)
    // -> tfaRequired is exactly what disableTfa() refuses to override; an admin doing this on
    //    purpose is the entire point of adminInvalidateTfa. setUserAuthFlags() only ever touches the
    //    local strategy, so the flag is set directly on this (fixture, non-local) strategy's entry.
    const flagged = (await usersModel.getById(fixtures.userId)) as any
    await fixtures.db
      .update(usersTable)
      .set({
        auth: { ...flagged.auth, [strategyId]: { ...flagged.auth[strategyId], tfaRequired: true } }
      })
      .where(eq(usersTable.id, fixtures.userId))

    await userCredentials.adminInvalidateTfa(fixtures.userId, strategyId)

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    assert.equal(reloaded.auth[strategyId].tfaIsActive, false)
    assert.equal(reloaded.auth[strategyId].tfaSecret, '')
    assert.deepEqual(reloaded.auth[strategyId].recoveryCodes, [])
  })

  test('adminInvalidateTfa throws ERR_INVALID_STRATEGY for a strategy the user has no entry for', async () => {
    await assert.rejects(
      userCredentials.adminInvalidateTfa(fixtures.userId, freshStrategyId()),
      /ERR_INVALID_STRATEGY/
    )
  })

  test('adminInvalidateTfa throws ERR_TFA_NOT_ACTIVE for a secret that was generated but never activated', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    await userCredentials.startTfaSetup(user, strategyId, fixtures.siteId)

    await assert.rejects(
      userCredentials.adminInvalidateTfa(fixtures.userId, strategyId),
      /ERR_TFA_NOT_ACTIVE/
    )
  })

  test('adminInvalidateTfa throws ERR_INVALID_USER for a user that does not exist', async () => {
    await assert.rejects(
      userCredentials.adminInvalidateTfa('00000000-0000-0000-0000-000000000000', freshStrategyId()),
      /ERR_INVALID_USER/
    )
  })

  describe('verifyTfaCode single-use (RFC 6238 §5.2)', () => {
    // -> RFC 6238 Appendix B's SHA-1 test vector, the same secret/code pair `helpers/totp.test.ts`
    //    verifies against -- reused here rather than re-derived, since what is under test is the
    //    persistence/replay-refusal wrapper around `verifyTotpCode`, not the HOTP algorithm itself.
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const codeForCounter1 = '287082' // Time=59_000ms -> counter = floor(59 / 30) = 1

    test('accepts a code once, then refuses the identical code presented again', async () => {
      const strategyId = freshStrategyId()
      const owner = (await usersModel.getById(fixtures.userId)) as any
      await fixtures.db
        .update(usersTable)
        .set({ auth: { ...owner.auth, [strategyId]: { tfaSecret: rfcSecret, tfaIsActive: true } } })
        .where(eq(usersTable.id, fixtures.userId))

      mock.timers.enable({ apis: ['Date'], now: 59_000 })
      try {
        const firstAttempt = await usersModel.getById(fixtures.userId)
        assert.equal(
          await userCredentials.verifyTfaCode(firstAttempt, strategyId, codeForCounter1),
          true
        )

        // -> Same code, same still-valid drift window, freshly-reloaded user: only the persisted
        //    `tfaLastCounter` this first call wrote stands between this and a second acceptance.
        const secondAttempt = await usersModel.getById(fixtures.userId)
        assert.equal(
          await userCredentials.verifyTfaCode(secondAttempt, strategyId, codeForCounter1),
          false
        )
      } finally {
        mock.timers.reset()
      }
    })

    test('persists the matched counter as tfaLastCounter', async () => {
      const strategyId = freshStrategyId()
      const owner = (await usersModel.getById(fixtures.userId)) as any
      await fixtures.db
        .update(usersTable)
        .set({ auth: { ...owner.auth, [strategyId]: { tfaSecret: rfcSecret, tfaIsActive: true } } })
        .where(eq(usersTable.id, fixtures.userId))

      mock.timers.enable({ apis: ['Date'], now: 59_000 })
      try {
        const attempt = await usersModel.getById(fixtures.userId)
        await userCredentials.verifyTfaCode(attempt, strategyId, codeForCounter1)
      } finally {
        mock.timers.reset()
      }

      const reloaded = (await usersModel.getById(fixtures.userId)) as any
      assert.equal(reloaded.auth[strategyId].tfaLastCounter, 1)
    })

    /*
      An otherwise-correct code, presented for an account that no longer exists by the time the
      replay-counter write runs. `verifyTfaCode` reads the secret off the caller's `user` object, so
      the TOTP comparison itself still succeeds -- what decides the answer is `patchStrategyAuth`,
      which re-reads the row inside the per-user advisory lock and returns `false` when there is no
      row to write back to. Deleting the account mid-verification therefore declines the login rather
      than accepting a code whose single-use counter could never be recorded.
    */
    test('declines a code for a user that vanished between the read and the write', async () => {
      const strategyId = freshStrategyId()
      const [doomed] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'vanishing-tfa@example.com',
          name: 'Vanishing User',
          isActive: true,
          isVerified: true,
          auth: { [strategyId]: { tfaSecret: rfcSecret, tfaIsActive: true } }
        })
        .returning()

      await fixtures.db.delete(usersTable).where(eq(usersTable.id, doomed!.id))

      mock.timers.enable({ apis: ['Date'], now: 59_000 })
      try {
        assert.equal(
          await userCredentials.verifyTfaCode(doomed, strategyId, codeForCounter1),
          false
        )
      } finally {
        mock.timers.reset()
      }
    })
  })
})

/**
 * The lost-update case #2149 closes: every whole-blob `auth` write in `models/userCredentials.ts`
 * (they lived on `models/users.ts` until that model was split) now reads, mutates and writes while
 * holding a `user-auth:<id>` advisory lock (`helpers/advisoryLock.ts`), so
 * two of these calls racing the same user's row can no longer have the second writer's stale copy of
 * the blob clobber the first writer's change. Before this, `adminInvalidateTfa()` blanking
 * `tfaSecret`/`tfaIsActive`/`recoveryCodes` was observed being undone by a concurrent
 * `changeOwnPassword()` that had already read the (still-active) blob and later wrote its own copy of
 * it back, with the password change alone surviving -- silently restoring 2FA the admin had just
 * turned off.
 *
 * This runs both calls concurrently via a real advisory lock against Postgres (not a mock), which is
 * the only way to actually exercise the serialization rather than merely asserting the source calls
 * `withAdvisoryLock`.
 */
describe(
  'userCredentials auth-write serialization (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let usersModel: typeof import('./users.ts').users

    before(async () => {
      ;({ users: usersModel } = await import('./users.ts'))
    })

    function freshStrategyId(): string {
      return `strategy-${Math.random().toString(36).slice(2)}`
    }

    test('an adminInvalidateTfa concurrent with a changeOwnPassword leaves 2FA blanked, not restored', async () => {
      const strategyId = freshStrategyId()
      const currentPassword = 'the-old-password'

      // -> Seed a strategy entry with both a password (changeOwnPassword's target) and active 2FA
      //    (adminInvalidateTfa's target) so the two operations' writes genuinely overlap on the same
      //    `auth[strategyId]` object rather than touching disjoint strategies.
      const seeded = (await usersModel.getById(fixtures.userId)) as any
      await fixtures.db
        .update(usersTable)
        .set({
          auth: {
            ...seeded.auth,
            [strategyId]: {
              password: await bcrypt.hash(currentPassword, 12),
              mustChangePwd: false,
              tfaIsActive: true,
              tfaSecret: 'existing-secret',
              recoveryCodes: [{ hash: 'x', usedAt: null }]
            }
          }
        })
        .where(eq(usersTable.id, fixtures.userId))

      await Promise.all([
        userCredentials.adminInvalidateTfa(fixtures.userId, strategyId),
        userCredentials.changeOwnPassword({
          userId: fixtures.userId,
          strategyId,
          currentPassword,
          newPassword: 'a-brand-new-password'
        })
      ])

      const reloaded = (await usersModel.getById(fixtures.userId)) as any
      const strategyAuth = reloaded.auth[strategyId]

      // -> The admin's action must have stuck, regardless of which write happened to land second.
      assert.equal(strategyAuth.tfaIsActive, false)
      assert.equal(strategyAuth.tfaSecret, '')
      assert.deepEqual(strategyAuth.recoveryCodes, [])

      // -> The password change must have stuck too -- neither write may be the one that gets lost.
      assert.equal(strategyAuth.mustChangePwd, false)
      assert.equal(await bcrypt.compare('a-brand-new-password', strategyAuth.password), true)
    })
  }
)
