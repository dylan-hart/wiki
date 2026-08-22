# Block Credential Domain Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confused-deputy gap in OpenProject #868's live-data block: a stored block
credential (an API token, created under `manage:sites`/`site:blocks`) can currently be sent to
*any* URL a `write:pages` author configures, because nothing ties the credential to where it's
allowed to go. This plan adds an admin-declared domain allowlist per credential, enforced
server-side before the secret is ever attached to an outbound request.

**Architecture:** A new `allowedDomains` text-array column on `blockCredentials`, set at creation
(non-empty required) and editable afterward via a dedicated route. `models/liveData.ts#resolve()`
checks the target URL's hostname against the credential's allowlist — using the same
one-level-wildcard matching convention TLS certs use (`*.example.com` matches `api.example.com`,
not `example.com` or `a.b.example.com`) — immediately after the existing SSRF private-address
check and before the secret is attached to any request. The admin UI gets a domain chip-list input
on credential creation and a new "Edit Domains" action.

**Tech Stack:** Backend: TypeScript 7, Fastify, Drizzle/Postgres, `node:test`. Frontend: Vue 3,
the `w-*` shared component library, Vitest.

**Spec:** No separate spec doc — this plan *is* the spec, arrived at through conversation with
Dylan on 2026-08-22 following the #868 overnight-review finding (see
`docs/superpowers/plans/` sibling context: the finding is recorded in the published "Overnight
Merge" report and in memory `project_overnight_merge_2026_08_22.md`). Grounded directly against
the current code in this worktree (branch `feature/868-credential-domain-allowlist`, forked from
`overnight-2026-08-22-merged`).

## Global Constraints

- Deny-by-default: an empty `allowedDomains` list means the credential cannot be used at all (the
  resolve path rejects every URL), never "unrestricted."
- Creating a credential REQUIRES at least one domain (`minItems: 1`). Editing an existing
  credential's domain list MAY reduce it to zero — that's the admin deliberately disabling it,
  which is safe (fail-closed), not a new hole.
- Matching is case-insensitive, one-level wildcard only (`*.example.com` matches exactly one extra
  label), and also accepts a bare IP-literal entry via plain exact-string match (no separate IP
  logic needed — the existing exact-match branch already covers it).
- No change to who may create/manage credentials (`manage:sites`/`site:blocks`, unchanged) or who
  may reference one in a block (`write:pages`, unchanged) — the fix scopes what a credential can be
  sent to, not who can use it.
- Run only tests scoped to the files each task touches. `DATABASE_URL` is not set in this
  environment; DB-backed suites report skipped, which is expected.
- `npm run typecheck`, `npx oxlint`, `npx oxfmt --check` clean on every touched file, per workspace,
  at the end of every task.

---

### Task 1: Domain allowlist matching helper

**Files:**
- Modify: `backend/helpers/network.ts`
- Test: `backend/helpers/network.test.ts`

**Interfaces:**
- Produces: `hostnameMatchesAllowlist(hostname: string, allowedDomains: string[]): boolean` — later
  tasks (`models/liveData.ts`) call this directly.

- [ ] **Step 1: Write the failing tests**

Append to `backend/helpers/network.test.ts` (after the existing `isPrivateAddress` describe
block, same file — add the import at the top alongside the existing one):

```ts
import { hostnameMatchesAllowlist, isPrivateAddress } from './network.ts'
```

```ts
describe('hostnameMatchesAllowlist', () => {
  test('matches an exact hostname', () => {
    assert.equal(hostnameMatchesAllowlist('api.example.com', ['api.example.com']), true)
  })

  test('does not match a different hostname', () => {
    assert.equal(hostnameMatchesAllowlist('evil.com', ['api.example.com']), false)
  })

  test('matches case-insensitively', () => {
    assert.equal(hostnameMatchesAllowlist('API.Example.COM', ['api.example.com']), true)
    assert.equal(hostnameMatchesAllowlist('api.example.com', ['API.EXAMPLE.COM']), true)
  })

  test('a wildcard pattern matches exactly one extra label', () => {
    assert.equal(hostnameMatchesAllowlist('api.example.com', ['*.example.com']), true)
  })

  test('a wildcard pattern does not match the bare root domain', () => {
    assert.equal(hostnameMatchesAllowlist('example.com', ['*.example.com']), false)
  })

  test('a wildcard pattern does not match two extra labels', () => {
    assert.equal(hostnameMatchesAllowlist('a.b.example.com', ['*.example.com']), false)
  })

  test('a wildcard pattern does not match an unrelated suffix', () => {
    assert.equal(hostnameMatchesAllowlist('api.notexample.com', ['*.example.com']), false)
  })

  test('matches a bare IP-literal entry by exact string', () => {
    assert.equal(hostnameMatchesAllowlist('203.0.113.5', ['203.0.113.5']), true)
    assert.equal(hostnameMatchesAllowlist('203.0.113.6', ['203.0.113.5']), false)
  })

  test('an empty allowlist matches nothing', () => {
    assert.equal(hostnameMatchesAllowlist('api.example.com', []), false)
  })

  test('matches when any one of several patterns matches', () => {
    assert.equal(
      hostnameMatchesAllowlist('api.example.com', ['other.com', '*.example.com']),
      true
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test helpers/network.test.ts`
Expected: FAIL — `hostnameMatchesAllowlist is not a function` (or a TypeScript import error, since
the export does not exist yet).

- [ ] **Step 3: Implement the helper**

Append to `backend/helpers/network.ts`:

```ts
/**
 * Whether `hostname` is covered by any pattern in `allowedDomains` — the enforcement half of the
 * per-credential domain allowlist (OpenProject #868 follow-up). An empty list matches nothing:
 * `models/blockCredentials.ts` requires at least one domain at creation time specifically so this
 * function is never the only thing standing between "credential exists" and "credential unusable."
 *
 * Matching is case-insensitive. A pattern starting with `*.` matches exactly one extra label before
 * the given suffix — the same convention a TLS wildcard certificate uses (`*.example.com` matches
 * `api.example.com`, not `example.com` itself and not `a.b.example.com`) — chosen because it is the
 * behavior most people already carry an intuition for, and it does not silently cover a whole
 * multi-level subtree an admin may not have intended. Any other pattern (including a bare IP
 * literal, since a URL's `hostname` for an IP-literal address is the literal itself) matches only by
 * exact string equality.
 */
export function hostnameMatchesAllowlist(hostname: string, allowedDomains: string[]): boolean {
  const target = hostname.toLowerCase()
  return allowedDomains.some((pattern) => {
    const normalized = pattern.toLowerCase()
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(1) // ".example.com"
      if (!target.endsWith(suffix)) {
        return false
      }
      const prefix = target.slice(0, target.length - suffix.length)
      return prefix.length > 0 && !prefix.includes('.')
    }
    return target === normalized
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test helpers/network.test.ts`
Expected: PASS, all tests including the pre-existing `isPrivateAddress` ones.

- [ ] **Step 5: Lint, format, typecheck**

Run: `cd backend && npx oxlint helpers/network.ts helpers/network.test.ts && npx oxfmt --check helpers/network.ts helpers/network.test.ts && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/helpers/network.ts backend/helpers/network.test.ts
git commit -m "feat: hostnameMatchesAllowlist helper for per-credential domain scoping (OpenProject #868)"
```

---

### Task 2: `allowedDomains` schema column + migration

**Files:**
- Modify: `backend/db/schema.ts`
- Create: `backend/db/migrations/<generated>/` (via `db-generate`, not hand-written)

**Interfaces:**
- Produces: `blockCredentials.allowedDomains` — a `text[]` column, `NOT NULL DEFAULT '{}'`. Task 3's
  model reads/writes it.

- [ ] **Step 1: Add the column**

In `backend/db/schema.ts`, find the `blockCredentials` table (search for
`export const blockCredentials = pgTable(`). Add `allowedDomains` after `secret`:

```ts
export const blockCredentials = pgTable(
  'blockCredentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    siteId: uuid()
      .notNull()
      .references(() => sites.id),
    name: varchar({ length: 255 }).notNull(),
    secret: text().notNull(),
    allowedDomains: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow()
  },
  (table) => [index('blockCredentials_siteId_idx').on(table.siteId)]
)
```

Also update this table's own header comment (the block ending at line 348, just above
`export const blockCredentials`) to mention the new column — append one sentence:

```
 * `allowedDomains` is the deny-by-default scoping list `models/liveData.ts#resolve()` checks a
 * block's configured URL against before ever attaching the secret — see that file's header comment.
```

- [ ] **Step 2: Generate the migration**

Run: `cd backend && npm run db-generate`
Expected: a new `backend/db/migrations/<timestamp>_main/` folder is created containing
`migration.sql` (an `ALTER TABLE "blockCredentials" ADD COLUMN "allowedDomains" text[] DEFAULT
ARRAY[]::text[] NOT NULL;`-shaped statement) and `snapshot.json`. Read the generated
`migration.sql` to confirm it contains exactly one `ALTER TABLE` statement for this column and
nothing else — if `drizzle-kit` proposes any other change, stop and investigate before continuing
(it means the schema and the last migration had already drifted before this task).

- [ ] **Step 3: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: clean (the new column now appears in `blockCredentialsTable.$inferSelect`/`$inferInsert`
types, which Task 3 relies on).

- [ ] **Step 4: Commit**

```bash
git add backend/db/schema.ts backend/db/migrations/
git commit -m "feat: add allowedDomains column to blockCredentials (OpenProject #868)"
```

---

### Task 3: Model layer — `allowedDomains` in create/update, `getSecret` → `getCredentialForResolve`

**Files:**
- Modify: `backend/models/blockCredentials.ts`
- Modify: `backend/models/blockCredentials.test.ts`
- Modify: `backend/models/liveData.ts` (caller of the renamed method — updated at the end of this
  task so the codebase never sits in a half-renamed state; the allowlist *enforcement* itself is
  Task 4)
- Modify: `backend/db/schema.ts` (one stale doc-comment reference to the renamed method)

**Interfaces:**
- Consumes: `hostnameMatchesAllowlist` is NOT used in this task (that's Task 4) — this task only
  moves data around.
- Produces:
  - `BlockCredential` interface gains `allowedDomains: string[]`.
  - `createCredential(siteId: string, name: string, secret: string, allowedDomains: string[]): Promise<BlockCredential>`
  - `updateAllowedDomains(siteId: string, id: string, allowedDomains: string[]): Promise<boolean>`
  - `getCredentialForResolve(siteId: string, id: string): Promise<{ secret: string; allowedDomains: string[] } | undefined>`
    (replaces `getSecret`, which is deleted — Task 4 is the only other caller and is updated in
    this same task's last step so nothing is left calling the old name)

- [ ] **Step 1: Write the failing tests**

In `backend/models/blockCredentials.test.ts`, update the existing `createCredential returns the
row without a secret field...` test (it currently calls `createCredential` with 3 args and
`getSecret` — both are changing) and add new ones. Replace that whole test with:

```ts
  test('createCredential returns the row without a secret field, getCredentialForResolve returns secret + domains', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Weather API',
      'sekret-token-1',
      ['api.example.com']
    )
    assert.equal(created.name, 'Weather API')
    assert.equal(created.siteId, fixtures.siteId)
    assert.deepEqual(created.allowedDomains, ['api.example.com'])
    assert.equal('secret' in created, false)

    const resolved = await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id)
    assert.equal(resolved?.secret, 'sekret-token-1')
    assert.deepEqual(resolved?.allowedDomains, ['api.example.com'])
  })

  test('createCredential stores every given domain, in order, no dedup applied at this layer', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Multi-domain',
      'secret',
      ['api.example.com', '*.internal.example.com']
    )
    assert.deepEqual(created.allowedDomains, ['api.example.com', '*.internal.example.com'])
  })

  test('updateAllowedDomains replaces the list and returns true, false for an unknown id', async () => {
    const created = await blockCredentials.createCredential(fixtures.siteId, 'Scoped', 'secret', [
      'old.example.com'
    ])

    const updated = await blockCredentials.updateAllowedDomains(fixtures.siteId, created.id, [
      'new.example.com'
    ])
    assert.equal(updated, true)
    const resolved = await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id)
    assert.deepEqual(resolved?.allowedDomains, ['new.example.com'])

    const missing = await blockCredentials.updateAllowedDomains(
      fixtures.siteId,
      '11111111-1111-4111-8111-111111111111',
      ['whatever.com']
    )
    assert.equal(missing, false)
  })

  test('updateAllowedDomains can clear the list to empty, deliberately disabling the credential', async () => {
    const created = await blockCredentials.createCredential(fixtures.siteId, 'Clearable', 'secret', [
      'api.example.com'
    ])
    const updated = await blockCredentials.updateAllowedDomains(fixtures.siteId, created.id, [])
    assert.equal(updated, true)
    const resolved = await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id)
    assert.deepEqual(resolved?.allowedDomains, [])
  })
```

Update `getSecret returns undefined for a credential id on a different site` to call the new
3-arg-plus-domains `createCredential` and the new method name:

```ts
  test('getCredentialForResolve returns undefined for a credential id on a different site', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Scoped',
      'scoped-secret',
      ['api.example.com']
    )
    const otherSiteId = '00000000-0000-4000-8000-000000000000'
    const resolved = await blockCredentials.getCredentialForResolve(otherSiteId, created.id)
    assert.equal(resolved, undefined)
  })
```

Update the remaining two tests (`rotateSecret replaces...`, `deleteCredential removes...`) to pass
a domains array to `createCredential` and to check `getCredentialForResolve(...)?.secret` instead
of a bare `getSecret(...)` return value:

```ts
  test('rotateSecret replaces the secret and returns true, false for an unknown id', async () => {
    const created = await blockCredentials.createCredential(fixtures.siteId, 'Rotates', 'old-secret', [
      'api.example.com'
    ])

    const rotated = await blockCredentials.rotateSecret(fixtures.siteId, created.id, 'new-secret')
    assert.equal(rotated, true)
    assert.equal(
      (await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id))?.secret,
      'new-secret'
    )

    const missing = await blockCredentials.rotateSecret(
      fixtures.siteId,
      '11111111-1111-4111-8111-111111111111',
      'whatever'
    )
    assert.equal(missing, false)
  })

  test('deleteCredential removes the row and returns false on a second call', async () => {
    const created = await blockCredentials.createCredential(fixtures.siteId, 'Doomed', 'bye', [
      'api.example.com'
    ])

    const deleted = await blockCredentials.deleteCredential(fixtures.siteId, created.id)
    assert.equal(deleted, true)
    assert.equal(await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id), undefined)

    const deletedAgain = await blockCredentials.deleteCredential(fixtures.siteId, created.id)
    assert.equal(deletedAgain, false)
  })
```

Also update the `getSiteCredentials lists a site's credentials without their secrets` test's two
`createCredential` calls to pass a domains array (`['api.example.com']` is fine for both) — it
otherwise stays as-is.

- [ ] **Step 2: Run the tests to verify they fail**

Run (requires a real Postgres — see `backend/test/db.ts`'s header, or skip straight to Step 3 if no
`DATABASE_URL` is available and rely on Step 4's typecheck to catch signature mismatches instead):
`DATABASE_URL=<your test db url> node --test models/blockCredentials.test.ts` from `backend/`.
Expected: FAIL — `createCredential` called with 4 args against a 3-arg signature is a TypeScript
error caught by `npm run typecheck` even before runtime; if you have no test database, run
`npm run typecheck` now and confirm it fails with exactly that shape of error.

- [ ] **Step 3: Implement the model changes**

Replace the full contents of `backend/models/blockCredentials.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { blockCredentials as blockCredentialsTable } from '../db/schema.ts'

/**
 * A stored credential's public shape — everything about it except `secret`, which never leaves this
 * model. See the file header below for why.
 */
export interface BlockCredential {
  id: string
  siteId: string
  name: string
  allowedDomains: string[]
  createdAt: Date
  updatedAt: Date
}

const publicSelection = {
  id: blockCredentialsTable.id,
  siteId: blockCredentialsTable.siteId,
  name: blockCredentialsTable.name,
  allowedDomains: blockCredentialsTable.allowedDomains,
  createdAt: blockCredentialsTable.createdAt,
  updatedAt: blockCredentialsTable.updatedAt
}

/**
 * Block credentials model (OpenProject #868, hardened by the #868 domain-allowlist follow-up)
 *
 * A block prop lives in a page's own markdown, readable by anyone holding `read:source` on that
 * page — not a safe place for an endpoint's auth token. This model is the credential store `block
 * -live-data` (and any future server-fetching block) points at instead: a block prop carries a
 * credential's `id` alone, and only this model's `getCredentialForResolve()` ever reads the
 * `secret` column back out, for the server-side fetch that resolves the block's data
 * (`models/liveData.ts`). Every other method here — the ones an API route can reach — returns
 * {@link BlockCredential}, which has no `secret` field to leak.
 *
 * `allowedDomains` is a second, independent boundary: even a caller who legitimately knows a
 * credential's id (any `write:pages` author who can read a page already using it) can only have
 * that credential sent to a domain the admin who created it explicitly allowed —
 * `models/liveData.ts#resolve()` is what enforces this, this model just stores and returns the
 * list. `createCredential` requires at least one domain; `updateAllowedDomains` may reduce that to
 * zero (deliberately disabling the credential — fail-closed, not a new hole).
 */
class BlockCredentials {
  /** A site's stored credentials, secrets excluded. What the admin credential list is built from. */
  async getSiteCredentials(siteId: string): Promise<BlockCredential[]> {
    return WIKI.db
      .select(publicSelection)
      .from(blockCredentialsTable)
      .where(eq(blockCredentialsTable.siteId, siteId))
      .orderBy(blockCredentialsTable.name)
  }

  /**
   * The secret and its allowlist, for the server-side fetch alone — the secret is never routed
   * through an API response.
   *
   * @returns `undefined` when no such credential exists on this site, so a caller cannot use this to
   *   probe whether an id from another site exists.
   */
  async getCredentialForResolve(
    siteId: string,
    id: string
  ): Promise<{ secret: string; allowedDomains: string[] } | undefined> {
    const [row] = await WIKI.db
      .select({ secret: blockCredentialsTable.secret, allowedDomains: blockCredentialsTable.allowedDomains })
      .from(blockCredentialsTable)
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return row
  }

  async createCredential(
    siteId: string,
    name: string,
    secret: string,
    allowedDomains: string[]
  ): Promise<BlockCredential> {
    const [row] = await WIKI.db
      .insert(blockCredentialsTable)
      .values({ siteId, name, secret, allowedDomains })
      .returning(publicSelection)
    return row!
  }

  /**
   * Replace a credential's secret, keeping its id, name and allowlist. Reissuing a leaked or
   * expiring token without an author having to update every block prop that references this
   * credential's id.
   *
   * @returns Whether a matching row was found and updated
   */
  async rotateSecret(siteId: string, id: string, secret: string): Promise<boolean> {
    const result = await WIKI.db
      .update(blockCredentialsTable)
      .set({ secret, updatedAt: new Date() })
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Replace a credential's allowed-domains list, keeping its id, name and secret. Unlike creation,
   * this may reduce the list to empty — an admin deliberately disabling the credential rather than
   * deleting it, which is safe (the credential simply stops resolving for every URL) rather than a
   * new exposure.
   *
   * @returns Whether a matching row was found and updated
   */
  async updateAllowedDomains(siteId: string, id: string, allowedDomains: string[]): Promise<boolean> {
    const result = await WIKI.db
      .update(blockCredentialsTable)
      .set({ allowedDomains, updatedAt: new Date() })
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  async deleteCredential(siteId: string, id: string): Promise<boolean> {
    const result = await WIKI.db
      .delete(blockCredentialsTable)
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  /** All of a site's credentials, called from `models/sites.ts#deleteSite()` — no FK cascade. */
  async deleteSiteCredentials(siteId: string): Promise<void> {
    await WIKI.db.delete(blockCredentialsTable).where(eq(blockCredentialsTable.siteId, siteId))
  }
}

export const blockCredentials = new BlockCredentials()
```

Now update the one other caller. In `backend/models/liveData.ts`, change the line:

```ts
      const secret = await WIKI.models.blockCredentials.getSecret(siteId, request.credentialId)
      if (secret === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      headers.Authorization = `Bearer ${secret}`
```

to:

```ts
      const credential = await WIKI.models.blockCredentials.getCredentialForResolve(
        siteId,
        request.credentialId
      )
      if (credential === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      headers.Authorization = `Bearer ${credential.secret}`
```

(The allowlist check itself — using `credential.allowedDomains` — is Task 4, not this step; this
step only keeps the codebase compiling under the renamed method.)

This rename leaves one stale reference: `backend/db/schema.ts`'s `blockCredentials` table comment
(around line 346) says "resolving `secret` happens entirely server-side
(`models/blockCredentials.ts`'s `getSecret()`)". Update just that one method-name mention:

```
 * alone; resolving `secret` happens entirely server-side (`models/blockCredentials.ts`'s
 * `getCredentialForResolve()`) and it is never serialized back into an API response — see that
 * model's header comment.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npm run typecheck` — must be clean (this is the primary signal available
without a live database).
If you have `DATABASE_URL` set: `node --test models/blockCredentials.test.ts` from `backend/` —
all tests pass.
Also run the existing live-data suite to confirm the rename didn't break it in a way TypeScript
wouldn't catch: `node --test models/liveData.test.ts` from `backend/` — this WILL fail right now,
because that test file still stubs `WIKI.models.blockCredentials.getSecret`, not
`getCredentialForResolve`, and still expects `getSecret` to resolve to a bare string. That's
expected and is fixed in Task 4, which also touches this same test file for the allowlist
enforcement itself — do not fix it here, to keep this task's diff focused on the model layer.

- [ ] **Step 5: Lint, format**

Run: `cd backend && npx oxlint models/blockCredentials.ts models/blockCredentials.test.ts models/liveData.ts && npx oxfmt --check models/blockCredentials.ts models/blockCredentials.test.ts models/liveData.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/models/blockCredentials.ts backend/models/blockCredentials.test.ts backend/models/liveData.ts backend/db/schema.ts
git commit -m "feat: thread allowedDomains through the credential model, rename getSecret to getCredentialForResolve (OpenProject #868)"
```

---

### Task 4: Enforce the allowlist in `liveData.ts#resolve()`

**Files:**
- Modify: `backend/models/liveData.ts`
- Modify: `backend/models/liveData.test.ts`

**Interfaces:**
- Consumes: `hostnameMatchesAllowlist` (Task 1), `blockCredentials.getCredentialForResolve` (Task 3,
  already wired in `resolve()` from Task 3 — this task adds the domain check using its
  `allowedDomains` field, which Task 3 fetched but did not yet check).

- [ ] **Step 1: Write the failing tests**

In `backend/models/liveData.test.ts`, the `before()`/`beforeEach()` mock setup stubs
`WIKI.models.blockCredentials.getSecret`. Replace the whole `before`/`beforeEach` block and the
`getSecret` variable with the renamed method returning the new shape:

```ts
describe('LiveData.resolve', () => {
  let getCredentialForResolve: ReturnType<typeof mock.fn>

  before(async () => {
    if (typeof Temporal === 'undefined') {
      const polyfill = await import('@js-temporal/polyfill')
      ;(globalThis as any).Temporal = polyfill.Temporal
    }
    ;(globalThis as any).WIKI = {
      cache: createCacheStub(),
      models: {
        blockCredentials: {
          getCredentialForResolve: mock.fn(async () => undefined)
        }
      }
    }
  })

  beforeEach(() => {
    getCredentialForResolve = mock.fn(async () => undefined)
    ;(WIKI.models.blockCredentials.getCredentialForResolve as any) = getCredentialForResolve
    mock.method(liveData as any, 'resolveAddresses', async () => ['93.184.216.34'])
  })
```

Update every existing test that used `getSecret.mock.mockImplementation(async () => 's3cr3t-token')`
to instead return the new shape with a permissive allowlist, e.g. the `resolves the credential and
sends it as a bearer token` test becomes:

```ts
  test('resolves the credential and sends it as a bearer token', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedDomains: ['example.com']
    }))
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://example.com/metrics',
      jsonPath: '$.v'
    })
    const [, init]: [unknown, { headers: Record<string, string> }] = fetchMock.mock.calls[0]
      .arguments as any
    assert.equal(init.headers.Authorization, 'Bearer s3cr3t-token')
  })
```

Apply the same shape change (`{ secret, allowedDomains: ['example.com'] }`) to the `never puts the
credential secret into the resolved result` test. The `throws Not Found for a credential id with no
matching row on this site` test's mock already resolves to `undefined`, which still means "no such
credential" under the new shape — leave that one as-is except renaming the variable it references
from `getSecret` to `getCredentialForResolve`.

Add new tests for the allowlist check itself, placed after the existing credential-related tests:

```ts
  test('throws Bad Request when the url is not in the credential\'s allowed domains', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedDomains: ['other.com']
    }))
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-1',
        url: 'https://example.com/metrics',
        jsonPath: '$.v'
      }),
      (err: any) => {
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })

  test('does not call fetch when the url is outside the allowlist', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedDomains: ['other.com']
    }))
    const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    await assert.rejects(
      liveData.resolve('site-1', {
        credentialId: 'cred-1',
        url: 'https://example.com/metrics',
        jsonPath: '$.v'
      })
    )
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test('allows the url when it matches a wildcard entry in the allowlist', async () => {
    getCredentialForResolve.mock.mockImplementation(async () => ({
      secret: 's3cr3t-token',
      allowedDomains: ['*.example.com']
    }))
    mock.method(globalThis, 'fetch', async () => jsonResponse({ v: 1 }))
    const result = await liveData.resolve('site-1', {
      credentialId: 'cred-1',
      url: 'https://api.example.com/metrics',
      jsonPath: '$.v'
    })
    assert.equal(result.value, undefined)
  })

  test('a request with no credentialId is never checked against any allowlist', async () => {
    mock.method(globalThis, 'fetch', async () => jsonResponse({ cpu: 5 }))
    const result = await liveData.resolve('site-1', {
      url: 'https://anything.example.net/metrics',
      jsonPath: '$.cpu'
    })
    assert.equal(result.value, 5)
    assert.equal(getCredentialForResolve.mock.calls.length, 0)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test models/liveData.test.ts`
Expected: FAIL — the three new allowlist-specific tests fail because `resolve()` does not yet check
`allowedDomains` at all (the "not in allowlist" cases currently succeed instead of throwing 400).

- [ ] **Step 3: Implement the enforcement**

In `backend/models/liveData.ts`, change the credential-resolution block inside `resolve()` from:

```ts
    if (request.credentialId) {
      const credential = await WIKI.models.blockCredentials.getCredentialForResolve(
        siteId,
        request.credentialId
      )
      if (credential === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      headers.Authorization = `Bearer ${credential.secret}`
    }
```

to:

```ts
    if (request.credentialId) {
      const credential = await WIKI.models.blockCredentials.getCredentialForResolve(
        siteId,
        request.credentialId
      )
      if (credential === undefined) {
        throw new CustomError('Not Found', 'No such credential on this site.', 404)
      }
      if (!hostnameMatchesAllowlist(url.hostname, credential.allowedDomains)) {
        throw new CustomError(
          'Bad Request',
          'url is not in this credential\'s allowed domains.',
          400
        )
      }
      headers.Authorization = `Bearer ${credential.secret}`
    }
```

Add the import at the top of the file:

```ts
import { hostnameMatchesAllowlist, isPrivateAddress } from '../helpers/network.ts'
```

(This replaces the existing `import { isPrivateAddress } from '../helpers/network.ts'` line — one
combined import, alphabetized.)

Also update the class's own header comment (the block starting `Resolves one `block-live-data`
instance's data...`) to add one sentence documenting the new check, right after the existing
sentence about the private-address guard:

```
 * A credential's `allowedDomains` is a second, independent guard, checked once a `credentialId` is
 * given: even an author who legitimately knows a credential's id may not point it at any URL — only
 * ones the admin who created that credential explicitly allowed. This is what stops a `write:pages`
 * author from exfiltrating a `manage:sites`-gated secret to a URL of their own choosing.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test models/liveData.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Lint, format, typecheck**

Run: `cd backend && npx oxlint models/liveData.ts models/liveData.test.ts && npx oxfmt --check models/liveData.ts models/liveData.test.ts && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/models/liveData.ts backend/models/liveData.test.ts
git commit -m "fix: liveData.resolve rejects a url outside its credential's allowed domains (OpenProject #868)"
```

---

### Task 5: API layer — allowedDomains on create, new update-domains route

**Files:**
- Modify: `backend/api/schemas/blockCredential.ts`
- Modify: `backend/api/blockCredentials.ts`
- Modify: `backend/api/blockCredentials.test.ts`

**Interfaces:**
- Consumes: `blockCredentials.createCredential(siteId, name, secret, allowedDomains)`,
  `blockCredentials.updateAllowedDomains(siteId, id, allowedDomains)` (Task 3).
- Produces: `POST /sites/:siteId/block-credentials` now requires `allowedDomains` in its body.
  New route: `POST /sites/:siteId/block-credentials/:credentialId/allowed-domains`.

- [ ] **Step 1: Write the failing tests**

In `backend/api/blockCredentials.test.ts`, the `createCredential` stub and its call-tracking array
need the new argument. Change:

```ts
  let createCredentialCalls: Array<{ siteId: string; name: string; secret: string }>
```
to
```ts
  let createCredentialCalls: Array<{
    siteId: string
    name: string
    secret: string
    allowedDomains: string[]
  }>
```

and:
```ts
  async function createCredential(siteId: string, name: string, secret: string) {
    createCredentialCalls.push({ siteId, name, secret })
    return { id: 'new-credential-id', siteId, name, createdAt: new Date(), updatedAt: new Date() }
  }
```
to
```ts
  async function createCredential(
    siteId: string,
    name: string,
    secret: string,
    allowedDomains: string[]
  ) {
    createCredentialCalls.push({ siteId, name, secret, allowedDomains })
    return {
      id: 'new-credential-id',
      siteId,
      name,
      allowedDomains,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }
```

Add an `updateAllowedDomains` stub alongside the other model stubs:
```ts
  let updateAllowedDomainsCalls: Array<{ siteId: string; id: string; allowedDomains: string[] }>
  let updateAllowedDomainsResult = true
  async function updateAllowedDomains(siteId: string, id: string, allowedDomains: string[]) {
    updateAllowedDomainsCalls.push({ siteId, id, allowedDomains })
    return updateAllowedDomainsResult
  }
```

Wire it into the `WIKI.models.blockCredentials` stub object in `before()`:
```ts
        blockCredentials: {
          getSiteCredentials,
          createCredential,
          rotateSecret,
          updateAllowedDomains,
          deleteCredential
        },
```

Reset the new state in `beforeEach()`:
```ts
    updateAllowedDomainsCalls = []
    updateAllowedDomainsResult = true
```

Update the two existing tests that call `POST .../block-credentials` to include `allowedDomains` in
the payload and assert it round-trips:

```ts
  test('site:blocks on this site may create a credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: {
        'x-test-permissions': '',
        'x-test-site-permissions': `site:blocks@${SITE_ID}`
      },
      payload: { name: 'Prod API', secret: 'sekret-abc', allowedDomains: ['api.example.com'] }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(createCredentialCalls.length, 1)
    assert.deepEqual(createCredentialCalls[0], {
      siteId: SITE_ID,
      name: 'Prod API',
      secret: 'sekret-abc',
      allowedDomains: ['api.example.com']
    })
    assert.equal('secret' in res.json(), false)
  })

  test('site:blocks granted for a different site does not carry over', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: {
        'x-test-permissions': '',
        'x-test-site-permissions': 'site:blocks@some-other-site'
      },
      payload: { name: 'Prod API', secret: 'sekret-abc', allowedDomains: ['api.example.com'] }
    })
    assert.equal(res.statusCode, 403)
  })
```

Add a new test proving the empty-list-on-create rejection:

```ts
  test('rejects creating a credential with no allowed domains', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { name: 'Prod API', secret: 'sekret-abc', allowedDomains: [] }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(createCredentialCalls.length, 0)
  })
```

Add a new `describe`-free block of tests for the new route, appended just before the closing `})`
of the file's outer `describe`:

```ts
  test('update domains: 404s when the model reports no matching credential', async () => {
    updateAllowedDomainsResult = false
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { allowedDomains: ['new.example.com'] }
    })
    assert.equal(res.statusCode, 404)
  })

  test('update domains: succeeds and threads the new list to the model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { allowedDomains: ['new.example.com', '*.other.com'] }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(updateAllowedDomainsCalls, [
      { siteId: SITE_ID, id: CREDENTIAL_ID, allowedDomains: ['new.example.com', '*.other.com'] }
    ])
  })

  test('update domains: an empty list is accepted (deliberately disabling the credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { allowedDomains: [] }
    })
    assert.equal(res.statusCode, 200)
  })

  test('update domains: requires manage:sites or site:blocks on this site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/block-credentials/${CREDENTIAL_ID}/allowed-domains`,
      headers: { 'x-test-permissions': '' },
      payload: { allowedDomains: ['new.example.com'] }
    })
    assert.equal(res.statusCode, 403)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test api/blockCredentials.test.ts`
Expected: FAIL — the schema does not require `allowedDomains` yet (so the empty-list test gets 200,
not 400) and the new route does not exist yet (404-on-missing-route, not the specific 404/403/200
the tests expect from real handler logic).

- [ ] **Step 3: Implement the schema and route changes**

In `backend/api/schemas/blockCredential.ts`, add `allowedDomains` to the shared response schema:

```ts
  app.addSchema({
    $id: 'BlockCredential',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      siteId: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string'
      },
      allowedDomains: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Domains (or `*.`-wildcard patterns) this credential's secret may be sent to. Empty means the credential cannot be used by any block."
      },
      createdAt: {
        type: 'string',
        format: 'date-time'
      },
      updatedAt: {
        type: 'string',
        format: 'date-time'
      }
    }
  })
```

In `backend/api/blockCredentials.ts`, update the CREATE route's body type, schema and handler:

```ts
  app.post<{ Params: { siteId: string }; Body: { name: string; secret: string; allowedDomains: string[] } }>(
    '/sites/:siteId/block-credentials',
    {
      schema: {
        summary: 'Create a block credential',
        description:
          'The secret is written once, here — it is never returned by this or any other route again. `allowedDomains` must name at least one domain: an empty list would mean the credential can never actually be used (see `models/liveData.ts`), which is never a state worth creating on purpose. Requires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: { siteId: { type: 'string', format: 'uuid' } },
          required: ['siteId']
        },
        body: {
          type: 'object',
          required: ['name', 'secret', 'allowedDomains'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            secret: {
              type: 'string',
              minLength: 1,
              description:
                'The bearer token / API key a block-live-data instance authenticates with.'
            },
            allowedDomains: {
              type: 'array',
              items: { type: 'string', minLength: 1, pattern: '^\\S+$' },
              minItems: 1,
              description:
                "Domains (or `*.`-wildcard patterns) this credential's secret may be sent to. At least one is required."
            }
          }
        },
        response: {
          200: { description: 'Block credential created', $ref: 'BlockCredential#' },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayManageCredentials(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return WIKI.models.blockCredentials.createCredential(
        req.params.siteId,
        req.body.name,
        req.body.secret,
        req.body.allowedDomains
      )
    }
  )
```

Add a new route, placed after the ROTATE route and before DELETE:

```ts
  /**
   * UPDATE A BLOCK CREDENTIAL'S ALLOWED DOMAINS
   */
  app.post<{ Params: { siteId: string; credentialId: string }; Body: { allowedDomains: string[] } }>(
    '/sites/:siteId/block-credentials/:credentialId/allowed-domains',
    {
      schema: {
        summary: "Replace a block credential's allowed domains",
        description:
          "Unlike creation, this may be set to an empty list — an admin deliberately disabling the credential rather than deleting it, which is safe: `models/liveData.ts` refuses every url for a credential with no allowed domains. Requires `manage:sites`, or `site:blocks` on this site.",
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            credentialId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'credentialId']
        },
        body: {
          type: 'object',
          required: ['allowedDomains'],
          properties: {
            allowedDomains: {
              type: 'array',
              items: { type: 'string', minLength: 1, pattern: '^\\S+$' },
              description:
                "Domains (or `*.`-wildcard patterns) this credential's secret may be sent to. May be empty."
            }
          }
        },
        response: {
          200: {
            description: 'Allowed domains updated successfully',
            type: 'object',
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } }
          },
          400: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      if (!mayManageCredentials(req, req.params.siteId)) {
        return reply.forbidden()
      }
      const updated = await WIKI.models.blockCredentials.updateAllowedDomains(
        req.params.siteId,
        req.params.credentialId,
        req.body.allowedDomains
      )
      if (!updated) {
        return reply.notFound('Credential does not exist.')
      }
      return { ok: true, message: 'Allowed domains updated successfully.' }
    }
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test api/blockCredentials.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Lint, format, typecheck**

Run: `cd backend && npx oxlint api/schemas/blockCredential.ts api/blockCredentials.ts api/blockCredentials.test.ts && npx oxfmt --check api/schemas/blockCredential.ts api/blockCredentials.ts api/blockCredentials.test.ts && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/api/schemas/blockCredential.ts backend/api/blockCredentials.ts backend/api/blockCredentials.test.ts
git commit -m "feat: require allowedDomains on credential creation, add allowed-domains update route (OpenProject #868)"
```

---

### Task 6: Admin UI — domain input on create, new "Edit Domains" dialog mode

**Files:**
- Modify: `frontend/src/components/BlockCredentialDialog.vue`
- Modify: `frontend/src/components/BlockCredentialDialog.test.js`
- Modify: `backend/locales/en.json`
- Modify: `blocks/block-live-data/component.js`

**Interfaces:**
- Consumes: `POST sites/:siteId/block-credentials` (now requires `allowedDomains`),
  `POST sites/:siteId/block-credentials/:credentialId/allowed-domains` (Task 5).
- Produces: `BlockCredentialDialog` accepts `mode: 'create' | 'rotate' | 'domains'`. Task 7's
  `AdminBlocks.vue` opens it with `mode: 'domains'` and a `credential` prop to edit an existing
  credential's list.

- [ ] **Step 1: Add locale strings**

In `backend/locales/en.json`, insert these new keys alphabetically among the existing
`admin.blocks.credential*` keys (they are already alphabetically sorted in that file — insert each
at its correct alphabetical position rather than appending them as a block):

```json
  "admin.blocks.credentialAllowedDomains": "Allowed Domains",
  "admin.blocks.credentialAllowedDomainsHint": "Type a domain (e.g. api.example.com, or *.example.com for its subdomains) and press Enter. Required: an empty list means this credential can never be used.",
  "admin.blocks.credentialAllowedDomainsRequired": "At least one allowed domain is required.",
  "admin.blocks.credentialDomains": "Edit Domains",
  "admin.blocks.credentialDomainsSubtitle": "Which domains {name}'s secret may be sent to. A block pointed anywhere else is refused before the secret is ever attached.",
  "admin.blocks.credentialDomainsUpdateFailed": "Failed to update the allowed domains.",
  "admin.blocks.credentialDomainsUpdateSuccess": "Allowed domains updated successfully.",
```

(Insert `credentialAllowedDomains`, `credentialAllowedDomainsHint`, and
`credentialAllowedDomainsRequired` between the existing `credentialAddSubtitle` and
`credentialCopyFailed` keys — alphabetically, `credentialAllowedDomains*` sorts right after
`credentialAddSubtitle`. Insert `credentialDomains`, `credentialDomainsSubtitle`,
`credentialDomainsUpdateFailed`, `credentialDomainsUpdateSuccess` between the existing
`credentialDeleteSuccess` and `credentialIdCopied` keys.)

- [ ] **Step 2: Write the failing tests**

Replace the full contents of `frontend/src/components/BlockCredentialDialog.test.js`:

```js
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import BlockCredentialDialog from './BlockCredentialDialog.vue'
import { useAdminStore } from '@/stores/admin'
import { queue as notifyQueue } from '@/composables/notify'

async function mountDialog(props) {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  const wrapper = mount(BlockCredentialDialog, {
    props,
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  await flushPromises()
  return { wrapper, adminStore }
}

/** Types into the domain entry field and fires its `keyup:enter` custom emit, same as a real Enter key. */
async function addDomain(wrapper, domain) {
  const domainInput = wrapper.findAll('input').at(-1)
  await domainInput.setValue(domain)
  await domainInput.trigger('keyup.enter')
}

describe('BlockCredentialDialog (mode: create)', () => {
  it('disables submit until name, secret and at least one domain are filled in', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    const submit = () =>
      wrapper.findAll('button').find((btn) => btn.text() === 'admin.blocks.credentialAdd')

    expect(submit().attributes('disabled')).toBeDefined()

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    expect(submit().attributes('disabled')).toBeDefined()

    await inputs[1].setValue('sekret-token')
    expect(submit().attributes('disabled')).toBeDefined()

    await addDomain(wrapper, 'api.example.com')
    expect(submit().attributes('disabled')).toBeUndefined()
  })

  it('adds a domain as a chip on Enter and clears the input, trimmed and deduplicated', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    await addDomain(wrapper, '  api.example.com  ')
    expect(wrapper.text()).toContain('api.example.com')
    await addDomain(wrapper, 'api.example.com')
    expect(wrapper.findAll('.w-chip, [class*=chip]').length).toBeLessThanOrEqual(1)
  })

  it('removes a domain chip when its remove control is clicked', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    await addDomain(wrapper, 'api.example.com')
    expect(wrapper.vm.state.allowedDomains).toEqual(['api.example.com'])
    await wrapper.find('[aria-label], .w-chip__remove, button').exists()
    wrapper.vm.removeDomain('api.example.com')
    expect(wrapper.vm.state.allowedDomains).toEqual([])
  })

  it('creates the credential with the entered domains, secret never in the emitted payload', async () => {
    const { wrapper, adminStore } = await mountDialog({ mode: 'create' })
    const created = {
      id: 'cred-1',
      siteId: 'site-1',
      name: 'Weather API',
      allowedDomains: ['api.example.com']
    }
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(created) })

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    await inputs[1].setValue('sekret-token')
    await addDomain(wrapper, 'api.example.com')

    const submit = wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialAdd')
    await submit.trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(`sites/${adminStore.currentSiteId}/block-credentials`, {
      json: { name: 'Weather API', secret: 'sekret-token', allowedDomains: ['api.example.com'] }
    })
    expect(wrapper.emitted('ok')).toEqual([[created]])
  })

  it('shows an error and does not emit ok when creation fails', async () => {
    const { wrapper } = await mountDialog({ mode: 'create' })
    const err = Object.assign(new Error('Request failed'), {
      data: { message: 'name is required.' }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockRejectedValue(err) })
    notifyQueue.length = 0

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('Weather API')
    await inputs[1].setValue('sekret-token')
    await addDomain(wrapper, 'api.example.com')
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialAdd')
      .trigger('click')
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      caption: 'name is required.'
    })
    expect(wrapper.emitted('ok')).toBeUndefined()
  })
})

describe('BlockCredentialDialog (mode: rotate)', () => {
  it('has no name field, no domain field, only a secret field, and posts to the rotate route', async () => {
    const { wrapper, adminStore } = await mountDialog({
      mode: 'rotate',
      credential: { id: 'cred-1', name: 'Weather API', allowedDomains: ['api.example.com'] }
    })
    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ ok: true }) })

    expect(wrapper.findAll('input')).toHaveLength(1)

    await wrapper.find('input').setValue('new-secret')
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialRotate')
      .trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/block-credentials/cred-1/rotate`,
      { json: { secret: 'new-secret' } }
    )
    expect(wrapper.emitted('ok')).toEqual([[undefined]])
  })
})

describe('BlockCredentialDialog (mode: domains)', () => {
  it('starts pre-filled with the credential\'s existing domains and posts the replaced list', async () => {
    const { wrapper, adminStore } = await mountDialog({
      mode: 'domains',
      credential: { id: 'cred-1', name: 'Weather API', allowedDomains: ['old.example.com'] }
    })
    expect(wrapper.text()).toContain('old.example.com')

    wrapper.vm.removeDomain('old.example.com')
    await addDomain(wrapper, 'new.example.com')

    API_CLIENT.post.mockReturnValueOnce({ json: vi.fn().mockResolvedValue({ ok: true }) })
    await wrapper
      .findAll('button')
      .find((btn) => btn.text() === 'admin.blocks.credentialDomains')
      .trigger('click')
    await flushPromises()

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      `sites/${adminStore.currentSiteId}/block-credentials/cred-1/allowed-domains`,
      { json: { allowedDomains: ['new.example.com'] } }
    )
    expect(wrapper.emitted('ok')).toEqual([[undefined]])
  })

  it('allows submitting an empty domain list, deliberately disabling the credential', async () => {
    const { wrapper } = await mountDialog({
      mode: 'domains',
      credential: { id: 'cred-1', name: 'Weather API', allowedDomains: ['old.example.com'] }
    })
    const submit = () =>
      wrapper.findAll('button').find((btn) => btn.text() === 'admin.blocks.credentialDomains')
    wrapper.vm.removeDomain('old.example.com')
    await wrapper.vm.$nextTick()
    expect(submit().attributes('disabled')).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/BlockCredentialDialog.test.js`
Expected: FAIL — `mode: 'domains'` is not a recognized prop value yet, there is no domain input,
`state.allowedDomains`/`removeDomain` do not exist.

- [ ] **Step 4: Implement the dialog changes**

Replace the full contents of `frontend/src/components/BlockCredentialDialog.vue`:

```vue
<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card style="width: 450px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-key-2.svg" size="sm" class="mr-2" />
        <span>{{ dialogTitle }}</span>
      </w-card-section>
      <w-card-section>
        <p class="text-body2 text-grey">
          {{ dialogSubtitle }}
        </p>
        <w-input
          v-if="mode === 'create'"
          outlined
          v-model="state.name"
          :label="t('admin.blocks.credentialName')"
          :hint="t('admin.blocks.credentialNameHint')"
          autofocus
          class="mb-2" />
        <w-input
          v-if="mode !== 'domains'"
          outlined
          v-model="state.secret"
          type="password"
          :autofocus="mode === 'rotate'"
          :label="t('admin.blocks.credentialSecret')"
          :hint="t('admin.blocks.credentialSecretHint')"
          class="mb-2" />
        <template v-if="mode !== 'rotate'">
          <div class="flex flex-wrap gap-1 mb-2" v-if="state.allowedDomains.length > 0">
            <w-chip
              v-for="domain of state.allowedDomains"
              :key="domain"
              square
              dense
              removable
              @remove="removeDomain(domain)">
              {{ domain }}
            </w-chip>
          </div>
          <w-input
            outlined
            v-model="state.domainInput"
            :autofocus="mode === 'domains'"
            :label="t('admin.blocks.credentialAllowedDomains')"
            :hint="t('admin.blocks.credentialAllowedDomainsHint')"
            @keyup:enter="addDomain">
            <template #append>
              <w-btn flat round dense icon="la:plus" :aria-label="t('common.actions.add')" @click="addDomain" />
            </template>
          </w-input>
        </template>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          unelevated
          :label="submitLabel"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          :disabled="submitDisabled"
          @click="submit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, reactive } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  mode: {
    type: String,
    required: true,
    validator: (value) => ['create', 'rotate', 'domains'].includes(value)
  },
  /** Required for mode `rotate` and `domains`: the credential row being edited. */
  credential: {
    type: Object,
    default: null
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  name: '',
  secret: '',
  allowedDomains: props.mode === 'domains' ? [...(props.credential?.allowedDomains ?? [])] : [],
  domainInput: '',
  isLoading: false
})

const dialogTitle = computed(() => {
  if (props.mode === 'rotate') return t('admin.blocks.credentialRotate')
  if (props.mode === 'domains') return t('admin.blocks.credentialDomains')
  return t('admin.blocks.credentialAdd')
})

const dialogSubtitle = computed(() => {
  if (props.mode === 'rotate') {
    return t('admin.blocks.credentialRotateSubtitle', { name: props.credential?.name ?? '' })
  }
  if (props.mode === 'domains') {
    return t('admin.blocks.credentialDomainsSubtitle', { name: props.credential?.name ?? '' })
  }
  return t('admin.blocks.credentialAddSubtitle')
})

const submitLabel = computed(() => dialogTitle.value)

const submitDisabled = computed(() => {
  if (props.mode === 'rotate') {
    return !state.secret.trim()
  }
  if (props.mode === 'domains') {
    return false
  }
  return !state.name.trim() || !state.secret.trim() || state.allowedDomains.length === 0
})

// METHODS

function addDomain() {
  const value = state.domainInput.trim().toLowerCase()
  state.domainInput = ''
  if (!value || state.allowedDomains.includes(value)) {
    return
  }
  state.allowedDomains.push(value)
}

function removeDomain(domain) {
  state.allowedDomains = state.allowedDomains.filter((d) => d !== domain)
}

async function submit() {
  state.isLoading = true
  try {
    if (props.mode === 'rotate') {
      const resp = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials/${props.credential.id}/rotate`,
        { json: { secret: state.secret } }
      ).json()
      if (!resp?.ok) {
        throw new Error(resp?.message || 'An unexpected error occured.')
      }
      notify({ type: 'positive', message: t('admin.blocks.credentialRotateSuccess') })
      onDialogOK()
    } else if (props.mode === 'domains') {
      const resp = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials/${props.credential.id}/allowed-domains`,
        { json: { allowedDomains: state.allowedDomains } }
      ).json()
      if (!resp?.ok) {
        throw new Error(resp?.message || 'An unexpected error occured.')
      }
      notify({ type: 'positive', message: t('admin.blocks.credentialDomainsUpdateSuccess') })
      onDialogOK()
    } else {
      const credential = await API_CLIENT.post(`sites/${adminStore.currentSiteId}/block-credentials`, {
        json: { name: state.name.trim(), secret: state.secret, allowedDomains: state.allowedDomains }
      }).json()
      notify({ type: 'positive', message: t('admin.blocks.credentialCreateSuccess') })
      onDialogOK(credential)
    }
  } catch (err) {
    const failMessage =
      props.mode === 'rotate'
        ? t('admin.blocks.credentialRotateFailed')
        : props.mode === 'domains'
          ? t('admin.blocks.credentialDomainsUpdateFailed')
          : t('admin.blocks.credentialCreateFailed')
    notify({
      type: 'negative',
      message: failMessage,
      caption: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

defineExpose({ state, removeDomain })
</script>
```

Note the `defineExpose({ state, removeDomain })` at the end — this is what lets the test file call
`wrapper.vm.state.allowedDomains` and `wrapper.vm.removeDomain(...)` directly under `<script
setup>`'s default encapsulation, the same way a test would need explicit exposure for any
script-setup component's internals.

- [ ] **Step 5: Update the block's own hint text for discoverability**

A rejected request otherwise just looks like a mystery 400 to the author configuring the block. In
`blocks/block-live-data/component.js`, find the `credentialId` entry in the static `properties`
array (search for `name: 'credentialId'`) and change its `hint`:

```js
      {
        name: 'credentialId',
        type: 'string',
        label: 'Credential ID',
        hint: "A stored credential's id, from this site's Content Blocks admin page. The url above must be within that credential's allowed domains, or the fetch is refused. Leave blank for an endpoint that takes no authentication."
      },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/BlockCredentialDialog.test.js`
Expected: PASS, all tests.

Run: `cd blocks && npx vitest run block-live-data/component.test.js`
Expected: PASS — confirm this suite has no test asserting the literal old hint string; if it does,
update that assertion to the new text as part of this same step (do not leave a test pinned to text
this step just changed).

- [ ] **Step 7: Lint, format, typecheck**

Run: `cd frontend && npx oxlint src/components/BlockCredentialDialog.vue src/components/BlockCredentialDialog.test.js && npx oxfmt --check src/components/BlockCredentialDialog.vue src/components/BlockCredentialDialog.test.js`
Run: `cd backend && npx oxlint locales/en.json 2>/dev/null; python3 -m json.tool backend/locales/en.json > /dev/null && echo "en.json is valid JSON"` (oxlint does not lint JSON; the `json.tool` round-trip is the real check that no comma/quote mistake was made editing it by hand).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/BlockCredentialDialog.vue frontend/src/components/BlockCredentialDialog.test.js backend/locales/en.json blocks/block-live-data/component.js
git commit -m "feat: BlockCredentialDialog gains a domain allowlist input and an edit-domains mode (OpenProject #868)"
```

---

### Task 7: Wire `AdminBlocks.vue` to show domains and trigger the edit dialog

**Files:**
- Modify: `frontend/src/pages/AdminBlocks.vue`
- Modify: `frontend/src/pages/AdminBlocks.test.js`

**Interfaces:**
- Consumes: `BlockCredentialDialog` with `mode: 'domains'` (Task 6).

- [ ] **Step 1: Write the failing test**

This file has no existing test for `rotateCredential`/`deleteCredential` opening their dialogs —
its `describe('AdminBlocks credentials list', ...)` block (around line 207) only asserts what
renders, via the real `mountAdminBlocks(blocks, credentials)` helper already defined at the top of
the file (mounts the real component, no dialog mocking). Follow the sibling pattern this codebase
DOES use elsewhere for a component that opens `dialog()` from `@/composables/dialog` —
`frontend/src/pages/AdminGlossary.test.js`'s `vi.mock('@/composables/dialog', ...)` block (its
lines 11-19) — rather than inventing a different mocking approach.

Add this `vi.mock` call at the top of `frontend/src/pages/AdminBlocks.test.js`, immediately after
the existing `import` statements (before the `KROKI_BLOCK` constant):

```js
vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  dialog: vi.fn(() => ({ onOk: vi.fn() }))
}))
```

Add `vi` to the existing `import { describe, expect, it } from 'vitest'` line, making it
`import { describe, expect, it, vi } from 'vitest'`.

Add `import { dialog } from '@/composables/dialog'` alongside the file's other imports (after the
`useUserStore` import), so the test can assert on the mocked function directly.

Add this test inside the existing `describe('AdminBlocks credentials list', ...)` block (around
line 207), as a new `it()` alongside the two already there:

```js
  it('opens BlockCredentialDialog in mode "domains" with the clicked credential when Edit Domains is clicked', async () => {
    const wrapper = await mountAdminBlocks(
      [],
      [
        {
          id: 'cred-1',
          siteId: 'site-1',
          name: 'Weather API',
          allowedDomains: ['api.example.com'],
          createdAt: '',
          updatedAt: ''
        }
      ]
    )

    const editDomainsBtn = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('admin.blocks.credentialDomains'))
    expect(editDomainsBtn).toBeTruthy()
    await editDomainsBtn.trigger('click')

    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: {
          mode: 'domains',
          credential: {
            id: 'cred-1',
            siteId: 'site-1',
            name: 'Weather API',
            allowedDomains: ['api.example.com'],
            createdAt: '',
            updatedAt: ''
          }
        }
      })
    )
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/AdminBlocks.test.js`
Expected: FAIL — no "Edit Domains" button exists yet.

- [ ] **Step 3: Implement the UI changes**

In `frontend/src/pages/AdminBlocks.vue`, find the credential list item's caption row (the one
showing `credential.id` in a chip) and add a second caption row beneath it showing the allowed
domains, plus a new "Edit Domains" button beside the existing "Rotate Secret" one:

```html
              <w-item-label caption class="flex items-center">
                <w-chip
                  class="m-0"
                  square
                  dense
                  :color="dark.isActive ? `blue-grey-8` : `blue-grey-1`"
                  :text-color="dark.isActive ? `white` : `blue-grey-9`">
                  <span class="text-caption">{{ credential.id }}</span>
                </w-chip>
                <w-btn
                  class="ml-1"
                  icon="la:copy"
                  flat
                  round
                  dense
                  size="sm"
                  :aria-label="t(`admin.blocks.credentialCopyId`)"
                  @click="copyCredentialId(credential.id)">
                  <w-tooltip>{{ t(`admin.blocks.credentialCopyId`) }}</w-tooltip>
                </w-btn>
              </w-item-label>
              <w-item-label caption class="flex flex-wrap items-center gap-1 mt-1">
                <w-icon name="la:globe" size="14px" class="mr-1" />
                <span v-if="credential.allowedDomains?.length" class="text-caption">
                  {{ credential.allowedDomains.join(', ') }}
                </span>
                <span v-else class="text-caption text-negative">{{
                  t('admin.blocks.credentialAllowedDomainsEmpty')
                }}</span>
              </w-item-label>
```

(The `<w-item-label caption class="flex items-center">...</w-item-label>` block above is the
EXISTING one — only the new `<w-item-label caption class="flex flex-wrap items-center gap-1
mt-1">` block after it is added.)

Add the new button in the `side` section, before the existing Rotate button:

```html
            <w-item-section side>
              <w-btn
                class="mr-2"
                icon="la:globe"
                :label="t(`admin.blocks.credentialDomains`)"
                :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                outline
                no-caps
                padding="xs md"
                @click="editDomains(credential)" />
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="mr-2"
                icon="la:sync-alt"
                :label="t(`admin.blocks.credentialRotate`)"
                :color="dark.isActive ? `blue-grey-3` : `blue-grey-8`"
                outline
                no-caps
                padding="xs md"
                @click="rotateCredential(credential)" />
            </w-item-section>
```

Add the handler function in the `<script setup>` block, right after the existing
`rotateCredential` function:

```js
function editDomains(credential) {
  dialog({
    component: BlockCredentialDialog,
    componentProps: { mode: 'domains', credential }
  }).onOk(() => {
    loadCredentials()
  })
}
```

(`loadCredentials()` is the existing function this file already calls on initial mount — reusing it
after a successful domain update is what refreshes the displayed `allowedDomains` list without a
separate patch-in-place code path.)

Add the missing locale key from Task 6's list — `credentialAllowedDomainsEmpty` was not yet added
there because it's only used here. Insert it into `backend/locales/en.json` alphabetically —
"Empty" sorts before "Hint", so this goes right after `credentialAllowedDomains` and before
`credentialAllowedDomainsHint` (NOT after Hint — double-check the three
`credentialAllowedDomains*` keys read Empty, Hint, Required in that order once this is in place):

```json
  "admin.blocks.credentialAllowedDomainsEmpty": "No allowed domains — this credential cannot be used by any block.",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/pages/AdminBlocks.test.js`
Expected: PASS.

- [ ] **Step 5: Lint, format, typecheck**

Run: `cd frontend && npx oxlint src/pages/AdminBlocks.vue src/pages/AdminBlocks.test.js && npx oxfmt --check src/pages/AdminBlocks.vue src/pages/AdminBlocks.test.js`
Run: `cd frontend && npm run icons` then `git diff --stat src/assets/icons.generated.js` — expect
NO changes, since `la:globe` is already present in the bundle (confirmed before writing this plan:
`grep -o '"la:globe"' src/assets/icons.generated.js` already matches on the current branch). If the
diff is non-empty, commit the regenerated bundle alongside this task's other files; if `npm run
icons` reports a mismatch some other way, stop and investigate rather than force-committing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AdminBlocks.vue frontend/src/pages/AdminBlocks.test.js backend/locales/en.json
git commit -m "feat: AdminBlocks shows each credential's allowed domains and an Edit Domains action (OpenProject #868)"
```

---

### Task 8: Full-branch verification

**Files:** none (verification only)

- [ ] **Step 1: Backend full check**

Run from `backend/`:
```bash
npm run typecheck
npx oxlint
npx oxfmt --check .
node --test helpers/network.test.ts models/blockCredentials.test.ts models/liveData.test.ts api/blockCredentials.test.ts
```
Expected: all clean; DB-backed tests in `blockCredentials.test.ts` report `SKIP` if `DATABASE_URL`
is unset (expected), or pass if it is set.

- [ ] **Step 2: If a database is available, run the DB-backed suite for real**

Per this repo's convention (`CLAUDE.md`'s Testing section), spin up a throwaway instance:
```bash
docker run --rm -d --name wiki-868-domains-db -p 56021:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:17
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56021/postgres node --test models/blockCredentials.test.ts
docker stop wiki-868-domains-db
```
from `backend/`. Expected: all pass, including the four new/updated `blockCredentials.test.ts`
cases from Task 3.

- [ ] **Step 3: Frontend full check**

Run from `frontend/`:
```bash
npx oxlint
npx oxfmt --check .
npx vitest run src/components/BlockCredentialDialog.test.js src/pages/AdminBlocks.test.js
```
Expected: all clean (oxfmt may report pre-existing unrelated format issues in files this branch did
not touch — confirm any reported file is NOT one this plan's tasks modified before treating the
check as passing; do not fix unrelated pre-existing issues as a drive-by).

- [ ] **Step 4: Confirm no unrelated diff**

Run: `git diff overnight-2026-08-22-merged...HEAD --stat`
Expected: only the files named across Tasks 1–7, plus the generated migration folder from Task 2.

- [ ] **Step 5: Report**

No commit for this task — it is verification-only. Summarize: all tests/lint/typecheck/format
clean, ready to merge `feature/868-credential-domain-allowlist` into
`overnight-2026-08-22-merged`.
