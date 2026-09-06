import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { createCacheStub, createEventsStub } from '../test/mocks.ts'
import { groups as groupsTable } from '../db/schema.ts'
import { glossary } from './glossary.ts'
import type { PageActor, PageInput } from './pages.ts'
import type { AccessActor } from './groups.ts'
import type { GlossaryAlias } from './glossary.ts'

/** Terser test fixture for a `GlossaryAlias` -- most tests below don't care about `isAcronym`. */
function alias(value: string, isAcronym = false): GlossaryAlias {
  return { value, isAcronym }
}

/**
 * OpenProject #2038: `invalidateCache()`'s cluster-broadcast half and `subscribeToEvents()`'s
 * inbound handler answering it are pure event-bus wiring, no SQL involved — so, per CLAUDE.md's
 * "prefer pure unit tests with no WIKI global and no database" guidance, this runs against
 * `test/mocks.ts` stubs rather than `test/db.ts`'s real, migrated database, the same way
 * `models/groups.test.ts` / `models/sites.test.ts` / `models/approvals.test.ts` cover their own
 * `broadcastReload()`/`subscribeToEvents()` pairs (there, against a real DB only because their
 * `reloadCache()` half is itself a SQL read this suite's equivalent, `dropLocalCache()`, is not).
 */
describe('glossary.invalidateCache() / subscribeToEvents() (pure, OpenProject #2038)', () => {
  let previousWiki: any
  let cache: ReturnType<typeof createCacheStub>
  let events: ReturnType<typeof createEventsStub>

  before(() => {
    previousWiki = (globalThis as any).WIKI
  })

  beforeEach(() => {
    cache = createCacheStub()
    events = createEventsStub()
    ;(globalThis as any).WIKI = { cache, events }
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('invalidateCache() deletes the local entry and emits exactly one outbound event carrying the siteId', () => {
    glossary.invalidateCache('site-1')

    assert.equal(cache.delete.mock.calls.length, 1)
    assert.deepEqual(cache.delete.mock.calls[0].arguments, ['glossary:site-1'])

    assert.equal(events.outbound.emit.mock.calls.length, 1)
    assert.deepEqual(events.outbound.emit.mock.calls[0].arguments, [
      'invalidateGlossaryCache',
      { siteId: 'site-1' }
    ])
  })

  test('subscribeToEvents() registers a handler that drops only the matching local key, without re-emitting', () => {
    glossary.subscribeToEvents()

    const onCalls = events.inbound.on.mock.calls
    const registered = onCalls.find((c: any) => c.arguments[0] === 'invalidateGlossaryCache')
    assert.ok(
      registered,
      'expected subscribeToEvents() to register an invalidateGlossaryCache handler'
    )
    const handler = registered!.arguments[1] as (evt: unknown) => void

    // -> Emittery (pinned 2.0.0) hands a specific `.on(eventName, listener)` the same `{ name, data }`
    //    wrapper `onAny` gets, not the raw payload -- see `core/db.ts`'s `notifyViaDB` and
    //    `core/db.test.ts`'s "echoing this same instance" test for the same shape read the same way.
    handler({ name: 'invalidateGlossaryCache', data: { siteId: 'site-2' } })

    assert.equal(cache.delete.mock.calls.length, 1)
    assert.deepEqual(cache.delete.mock.calls[0].arguments, ['glossary:site-2'])
    assert.equal(
      events.outbound.emit.mock.calls.length,
      0,
      'the inbound handler must never re-broadcast, or an invalidation would echo around the cluster forever'
    )
  })

  test("subscribeToEvents()'s handler is a no-op for an event with no siteId", () => {
    glossary.subscribeToEvents()
    const handler = events.inbound.on.mock.calls.find(
      (c: any) => c.arguments[0] === 'invalidateGlossaryCache'
    )!.arguments[1] as (evt: unknown) => void

    handler({ name: 'invalidateGlossaryCache', data: {} })

    assert.equal(cache.delete.mock.calls.length, 0)
  })
})

/**
 * `models/glossary.ts` is almost entirely SQL — an insert with a case-insensitive uniqueness
 * constraint, an update, a delete, and a join resolving each term's canonical page to a link — so a
 * mock of the query builder would mostly be re-describing the code under test rather than verifying
 * it. This suite runs the real methods against a migrated, per-run-fresh database (see `test/db.ts`).
 */
describe('glossary CRUD + cache (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let glossaryModel: typeof import('./glossary.ts').glossary
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    // -> The versioning tests below compare `GlossaryVersionSummary.createdAt` via
    //    `Date#toTemporalInstant()` + `Temporal.Instant.compare()`, per CLAUDE.md's "Backend patterns".
    await ensureTemporal()
    fixtures = await setupTestDb()
    ;({ glossary: glossaryModel } = await import('./glossary.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'docs/api',
      title: 'API Docs',
      editor: 'markdown',
      content: '# API',
      ...overrides
    }
  }

  test('createTerm() + listTerms() round-trip, alphabetical', async () => {
    await glossaryModel.createTerm(fixtures.siteId, { term: 'Zulu', definition: 'Last letter.' })
    await glossaryModel.createTerm(fixtures.siteId, { term: 'Alpha', definition: 'First letter.' })

    const terms = await glossaryModel.listTerms(fixtures.siteId)
    const names = terms.map((t) => t.term)
    assert.ok(names.indexOf('Alpha') < names.indexOf('Zulu'))
  })

  test('createTerm() rejects an empty term', async () => {
    await assert.rejects(
      () => glossaryModel.createTerm(fixtures.siteId, { term: '   ', definition: 'Something.' }),
      /cannot be empty/
    )
  })

  test('createTerm() rejects an empty definition', async () => {
    await assert.rejects(
      () => glossaryModel.createTerm(fixtures.siteId, { term: 'Something', definition: '  ' }),
      /cannot be empty/
    )
  })

  test('createTerm() rejects a case-insensitive duplicate of an existing term', async () => {
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'API',
      definition: 'First definition.'
    })

    await assert.rejects(async () => {
      try {
        await glossaryModel.createTerm(fixtures.siteId, { term: 'api', definition: 'Second.' })
      } catch (err: any) {
        assert.equal(err.statusCode, 409)
        throw err
      }
    }, /already exists/)
  })

  test('createTerm() rejects a pageId that does not exist on this site', async () => {
    await assert.rejects(async () => {
      try {
        await glossaryModel.createTerm(fixtures.siteId, {
          term: 'Orphan',
          definition: 'Points nowhere.',
          pageId: '00000000-0000-0000-0000-000000000000'
        })
      } catch (err: any) {
        assert.equal(err.statusCode, 400)
        throw err
      }
    }, /does not exist/)
  })

  test('createTerm() accepts a pageId that belongs to this site', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-1' }),
      actor
    )

    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Linked Term',
      definition: 'Has a canonical page.',
      pageId: page.id
    })

    assert.equal(created.pageId, page.id)
  })

  test('updateTerm() updates the fields given and leaves the rest untouched', async () => {
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Original',
      definition: 'Original definition.'
    })

    const updated = await glossaryModel.updateTerm(fixtures.siteId, created.id, {
      definition: 'Updated definition.'
    })

    assert.equal(updated.term, 'Original')
    assert.equal(updated.definition, 'Updated definition.')
  })

  test('updateTerm() can clear a canonical page by setting pageId to null', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/glossary-2' }),
      actor
    )
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Unlink Me',
      definition: 'Will lose its page.',
      pageId: page.id
    })

    const updated = await glossaryModel.updateTerm(fixtures.siteId, created.id, { pageId: null })

    assert.equal(updated.pageId, null)
  })

  test('updateTerm() rejects an id that does not exist', async () => {
    await assert.rejects(async () => {
      try {
        await glossaryModel.updateTerm(fixtures.siteId, '00000000-0000-0000-0000-000000000000', {
          definition: 'Anything.'
        })
      } catch (err: any) {
        assert.equal(err.statusCode, 404)
        throw err
      }
    }, /does not exist/)
  })

  test('deleteTerm() removes the row and reports true, false when nothing was there', async () => {
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Deletable',
      definition: 'Gone soon.'
    })

    assert.equal(await glossaryModel.deleteTerm(fixtures.siteId, created.id), true)
    assert.equal(await glossaryModel.deleteTerm(fixtures.siteId, created.id), false)
    assert.equal(await glossaryModel.getTerm(fixtures.siteId, created.id), null)
  })

  test('getCachedTerms() resolves a canonical page to a locale-aware link, and null without one', async () => {
    const enPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cached-en', locale: 'en' }),
      actor
    )
    const frPage = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/cached-fr', locale: 'fr' }),
      actor
    )
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'CacheEn',
      definition: 'English page link.',
      pageId: enPage.id
    })
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'CacheFr',
      definition: 'French page link.',
      pageId: frPage.id
    })
    await glossaryModel.createTerm(fixtures.siteId, {
      term: 'CacheNone',
      definition: 'No canonical page.'
    })

    const cached = await glossaryModel.getCachedTerms(fixtures.siteId, actor)
    const byTerm = Object.fromEntries(cached.map((t) => [t.term, t]))

    // -> The fixture site's primary locale is 'en' (test/db.ts), so an 'en' page link carries no
    //    locale prefix while the non-primary 'fr' one does — see `localizedPagePath`.
    assert.equal(byTerm.CacheEn!.link, '/docs/cached-en')
    assert.equal(byTerm.CacheFr!.link, '/fr/docs/cached-fr')
    assert.equal(byTerm.CacheNone!.link, null)
  })

  /**
   * OpenProject #1127: `getCachedTerms` used to bake a term's canonical-page `link` in with no
   * permission check at all -- every reader got the same resolved link regardless of whether they
   * could read the linked page themselves. It now resolves `link` fresh per `actor`'s own
   * `read:pages` access, so an actor without it sees the term as plain, unlinked text (the definition
   * still comes through -- only the link is gated), exactly like a term with no canonical page set.
   */
  test('getCachedTerms() resolves a link only for an actor with read:pages on the canonical page', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'docs/gated-term-target' }),
      actor
    )
    const term = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'GatedTerm',
      definition: 'Points at a page not every actor may read.',
      pageId: page.id
    })
    try {
      // -> The fixture group's own `rules` column starts empty (`setupTestDb`), so an actor speaking
      //    only for it -- no `manage:system`, unlike the shared `actor` above -- gets no ALLOW rule
      //    at all: fails closed, per `helpers/pageRules.ts`.
      const noAccessActor: AccessActor = { groupIds: [fixtures.groupId], permissions: [] }
      const denied = await glossaryModel.getCachedTerms(fixtures.siteId, noAccessActor)
      const deniedTerm = denied.find((t) => t.term === 'GatedTerm')
      assert.equal(deniedTerm?.link, null)
      assert.equal(deniedTerm?.definition, 'Points at a page not every actor may read.')

      await fixtures.db
        .update(groupsTable)
        .set({
          rules: [
            {
              id: 'allow-gated-term-target',
              name: 'Allow',
              roles: ['read:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        })
        .where(eq(groupsTable.id, fixtures.groupId))
      await WIKI.models.groups.reloadCache()

      const allowed = await glossaryModel.getCachedTerms(fixtures.siteId, noAccessActor)
      assert.equal(allowed.find((t) => t.term === 'GatedTerm')?.link, '/docs/gated-term-target')
    } finally {
      await glossaryModel.deleteTerm(fixtures.siteId, term.id)
      await fixtures.db
        .update(groupsTable)
        .set({ rules: [] })
        .where(eq(groupsTable.id, fixtures.groupId))
      await WIKI.models.groups.reloadCache()
    }
  })

  test('a write invalidates the cache: the next read sees the change, not a stale one', async () => {
    const created = await glossaryModel.createTerm(fixtures.siteId, {
      term: 'Mutable',
      definition: 'Before update.'
    })
    const before = await glossaryModel.getCachedTerms(fixtures.siteId, actor)
    assert.equal(before.find((t) => t.term === 'Mutable')?.definition, 'Before update.')

    await glossaryModel.updateTerm(fixtures.siteId, created.id, { definition: 'After update.' })

    const after = await glossaryModel.getCachedTerms(fixtures.siteId, actor)
    assert.equal(after.find((t) => t.term === 'Mutable')?.definition, 'After update.')
  })

  test('a second read within the cache window hits the cache rather than the database', async () => {
    await glossaryModel.createTerm(fixtures.siteId, { term: 'CacheHit', definition: 'Cached.' })
    await glossaryModel.getCachedTerms(fixtures.siteId, actor)
    const getCallsBefore = (WIKI.cache.get as any).mock.callCount()

    await glossaryModel.getCachedTerms(fixtures.siteId, actor)

    assert.equal((WIKI.cache.get as any).mock.callCount(), getCallsBefore + 1)
  })

  test('a fresh cache entry carries a bounded ttl (OpenProject #2038 defence-in-depth belt)', async () => {
    await glossaryModel.createTerm(fixtures.siteId, { term: 'TtlBound', definition: 'Bounded.' })
    ;(WIKI.cache.set as any).mock.resetCalls()

    await glossaryModel.getCachedTerms(fixtures.siteId, actor)

    const setCalls = (WIKI.cache.set as any).mock.calls
    assert.equal(setCalls.length, 1, 'expected exactly one cache repopulation for the cold key')
    const [, , options] = setCalls[0].arguments
    assert.ok(
      typeof options?.ttl === 'number' && options.ttl > 0 && Number.isFinite(options.ttl),
      `expected a bounded ttl, so a missed invalidation diverges for minutes rather than forever; got ${JSON.stringify(options)}`
    )
  })

  describe('aliases (OpenProject #1110)', () => {
    test('createTerm() trims, dedupes case-insensitively, and drops an alias matching the term', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'Hot Strip Mill',
        definition: 'A rolling mill.',
        aliases: [alias('  HSM  '), alias('Hot Mill'), alias('hsm'), alias('Hot Strip Mill')]
      })

      assert.deepEqual(created.aliases, [alias('HSM'), alias('Hot Mill')])
    })

    test('createTerm() rejects an alias that collides with another term', async () => {
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'Standalone',
        definition: 'Standalone term.'
      })

      await assert.rejects(async () => {
        try {
          await glossaryModel.createTerm(fixtures.siteId, {
            term: 'Uses Standalone As Alias',
            definition: 'A rolling mill.',
            aliases: [alias('Standalone')]
          })
        } catch (err: any) {
          assert.equal(err.statusCode, 409)
          throw err
        }
      }, /already exists/)
    })

    test('createTerm() rejects an alias that collides with another term’s alias', async () => {
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'First Mill',
        definition: 'First.',
        aliases: [alias('Mill Alias A')]
      })

      await assert.rejects(
        () =>
          glossaryModel.createTerm(fixtures.siteId, {
            term: 'Second Mill',
            definition: 'Second.',
            aliases: [alias('mill alias a')]
          }),
        /already exists/
      )
    })

    test('updateTerm() re-checks the full surface-form set when only aliases change', async () => {
      await glossaryModel.createTerm(fixtures.siteId, { term: 'Taken', definition: 'Exists.' })
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'Other',
        definition: 'Another term.'
      })

      await assert.rejects(
        () => glossaryModel.updateTerm(fixtures.siteId, created.id, { aliases: [alias('taken')] }),
        /already exists/
      )
    })

    test('updateTerm() allows re-saving a term’s own existing aliases unchanged', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'Stable',
        definition: 'Has aliases.',
        aliases: [alias('Alias One')]
      })

      const updated = await glossaryModel.updateTerm(fixtures.siteId, created.id, {
        definition: 'Updated.'
      })

      assert.deepEqual(updated.aliases, [alias('Alias One')])
    })

    test('updateTerm() drops an alias that a term rename now collides with', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'Rename Collides Mill',
        definition: 'A rolling mill.',
        aliases: [alias('RCM')]
      })

      const updated = await glossaryModel.updateTerm(fixtures.siteId, created.id, {
        term: 'rcm'
      })

      assert.deepEqual(updated.aliases, [])
    })

    test('getCachedTerms() carries each entry’s aliases through', async () => {
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'Aliased',
        definition: 'Has aliases.',
        aliases: [alias('AL')]
      })

      const cached = await glossaryModel.getCachedTerms(fixtures.siteId, actor)
      assert.deepEqual(cached.find((t) => t.term === 'Aliased')?.aliases, [alias('AL')])
    })

    /**
     * OpenProject #2598 (Issues #2590/#2591/#2595). `20260905142836_main` reached the jsonb column
     * by `SET DATA TYPE jsonb USING to_jsonb("aliases")` over the old `text[]`, which produces an
     * array of plain STRINGS rather than the `{ value, isAcronym }` rows everything above assumes,
     * so a term saved before that migration came back the wrong shape and
     * `assertNoSurfaceFormCollision`'s `a.value.toLowerCase()` threw on it. The column is now
     * squashed into the genesis `CREATE TABLE` and no conversion runs at all — these two assert
     * that against the REAL migrated database `setupTestDb()` stands up, which is the only place
     * the migration SQL's actual effect (as opposed to `db/schema.ts`'s declaration of it) is
     * observable.
     */
    test('the migrated column is physically jsonb, not text[]', async () => {
      const result: any = await fixtures.db.execute(sql`
        SELECT data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = ${fixtures.schema}
          AND table_name = 'glossaryTerms'
          AND column_name = 'aliases'
      `)
      const [row] = result.rows
      assert.ok(row, 'expected glossaryTerms.aliases to exist in the migrated schema')
      assert.equal(row.data_type, 'jsonb')
      assert.equal(row.udt_name, 'jsonb')
    })

    test('a two-alias term round-trips as {value, isAcronym} rows and collides on re-save without throwing a TypeError', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'United States Ship',
        definition: 'A commissioned vessel.',
        aliases: [alias('USS', true), alias('US Ship')]
      })

      // -> Read back off the raw column, not just the model's return value: `to_jsonb(text[])`
      //    would have stored `["USS","US Ship"]`, which a `.map((a) => a.value)` cannot survive.
      const stored: any = await fixtures.db.execute(
        sql`SELECT aliases FROM "glossaryTerms" WHERE id = ${created.id}`
      )
      assert.deepEqual(stored.rows[0].aliases, [
        { value: 'USS', isAcronym: true },
        { value: 'US Ship', isAcronym: false }
      ])
      assert.deepEqual(created.aliases, [alias('USS', true), alias('US Ship')])

      // -> `assertNoSurfaceFormCollision` walks every existing row's `aliases` and reads
      //    `a.value.toLowerCase()`. Against the wrong shape that is the reported
      //    `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`; against the
      //    right one it is an ordinary 409.
      await assert.rejects(
        () =>
          glossaryModel.createTerm(fixtures.siteId, {
            term: 'Another Vessel',
            definition: 'Collides on an alias.',
            aliases: [alias('uss')]
          }),
        (err: any) => {
          assert.equal(err.statusCode, 409)
          assert.ok(!(err instanceof TypeError), `expected a 409, got a TypeError: ${err.message}`)
          return true
        }
      )
    })
  })

  describe('acronyms (OpenProject #2575)', () => {
    test('createTerm() persists a term-level isAcronym flag, defaulting to false', async () => {
      const plain = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AcroPlainTerm',
        definition: 'Not an acronym.'
      })
      assert.equal(plain.isAcronym, false)

      const acronymTerm = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AcroUSS',
        definition: 'United States Ship.',
        isAcronym: true
      })
      assert.equal(acronymTerm.isAcronym, true)
    })

    test('createTerm() persists per-alias isAcronym flags, distinct from an ordinary alias', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AcroExpandedForm',
        definition: 'A software interface.',
        aliases: [alias('AcroAPI', true), alias('AcroInterface')]
      })

      assert.deepEqual(created.aliases, [alias('AcroAPI', true), alias('AcroInterface', false)])
    })

    test('updateTerm() flips a term’s isAcronym flag and records it as changed', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AcroToggleAcronym',
        definition: 'Starts plain.'
      })

      const updated = await glossaryModel.updateTerm(fixtures.siteId, created.id, {
        isAcronym: true
      })

      assert.equal(updated.isAcronym, true)
    })

    test('getAcronymMap() maps every acronym term/alias, lowercase key to canonical casing', async () => {
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AcroMapUSS',
        definition: 'United States Ship.',
        isAcronym: true
      })
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AcroMapExpandedForm',
        definition: 'A software interface.',
        aliases: [alias('AcroMapAPI', true), alias('AcroMapInterface')]
      })
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AcroMapPlainOnly',
        definition: 'No acronyms here at all.',
        aliases: [alias('AcroMapPlainAlias')]
      })

      const map = await glossaryModel.getAcronymMap(fixtures.siteId)

      assert.equal(map.acromapuss, 'AcroMapUSS')
      assert.equal(map.acromapapi, 'AcroMapAPI')
      assert.equal('acromapinterface' in map, false)
      assert.equal('acromapplainonly' in map, false)
      assert.equal('acromapplainalias' in map, false)
    })
  })

  describe('export / import (OpenProject #1114)', () => {
    test('exportTerms() carries the canonical page as a path, not a pageId', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/export-linked' }),
        actor
      )
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'ExportedLinked',
        definition: 'Has a page.',
        aliases: [alias('EL')],
        pageId: page.id
      })
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'ExportedUnlinked',
        definition: 'No page.'
      })

      const exported = await glossaryModel.exportTerms(fixtures.siteId)

      assert.equal(exported.formatVersion, 2)
      const linked = exported.terms.find((t) => t.term === 'ExportedLinked')
      assert.deepEqual(linked, {
        term: 'ExportedLinked',
        definition: 'Has a page.',
        aliases: [alias('EL')],
        isAcronym: false,
        path: 'docs/export-linked'
      })
      const unlinked = exported.terms.find((t) => t.term === 'ExportedUnlinked')
      assert.equal(unlinked?.path, null)
    })

    test('importTerms() replaces the glossary wholesale', async () => {
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'PreExisting',
        definition: 'Will be gone after import.'
      })

      const imported = await glossaryModel.importTerms(fixtures.siteId, {
        formatVersion: 2,
        terms: [
          {
            term: 'Imported One',
            definition: 'First.',
            aliases: [alias('IO')],
            isAcronym: false,
            path: null
          },
          { term: 'Imported Two', definition: 'Second.', aliases: [], isAcronym: false, path: null }
        ]
      })

      assert.equal(imported.length, 2)
      const remaining = await glossaryModel.listTerms(fixtures.siteId)
      assert.deepEqual(remaining.map((t) => t.term).sort(), ['Imported One', 'Imported Two'])
    })

    test('importTerms() resolves a path to a pageId against the site’s primary locale', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/import-target' }),
        actor
      )

      const imported = await glossaryModel.importTerms(fixtures.siteId, {
        formatVersion: 2,
        terms: [
          {
            term: 'ImportLinked',
            definition: 'Resolves.',
            aliases: [],
            isAcronym: false,
            path: 'docs/import-target'
          }
        ]
      })

      assert.equal(imported[0]!.pageId, page.id)
    })

    test('importTerms() rejects an unresolvable path, applying nothing', async () => {
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'SurvivesFailedImport',
        definition: 'Should still be here after.'
      })

      await assert.rejects(
        () =>
          glossaryModel.importTerms(fixtures.siteId, {
            formatVersion: 2,
            terms: [
              {
                term: 'BadPath',
                definition: 'Points nowhere.',
                aliases: [],
                isAcronym: false,
                path: 'docs/does-not-exist-anywhere'
              }
            ]
          }),
        /does not resolve/
      )

      const remaining = await glossaryModel.listTerms(fixtures.siteId)
      assert.ok(remaining.some((t) => t.term === 'SurvivesFailedImport'))
      assert.ok(!remaining.some((t) => t.term === 'BadPath'))
    })

    test('importTerms() rejects a bare "/" path rather than defaulting it to the home page (OpenProject #1936)', async () => {
      // -> Unlike `api/pages/read.ts`'s page-view route and `mcp/tools/getPage.ts`, `resolvePagePath()`
      //    does NOT fall back to `generatePathHash('home')` for a path that normalizes to empty --
      //    see the comment on `resolvePagePath()` in `models/glossary.ts`. A home page existing on
      //    the site must not change that: "/" still fails to resolve.
      await pagesModel.createPage(fixtures.siteId, pageInput({ path: 'home' }), actor)

      await assert.rejects(
        () =>
          glossaryModel.importTerms(fixtures.siteId, {
            formatVersion: 2,
            terms: [
              {
                term: 'RootPath',
                definition: 'Points at "/".',
                aliases: [],
                isAcronym: false,
                path: '/'
              }
            ]
          }),
        /does not resolve/
      )
    })

    test('importTerms() rejects two entries in the same payload sharing a surface form', async () => {
      await assert.rejects(
        () =>
          glossaryModel.importTerms(fixtures.siteId, {
            formatVersion: 2,
            terms: [
              {
                term: 'Dup A',
                definition: 'First.',
                aliases: [alias('Shared')],
                isAcronym: false,
                path: null
              },
              {
                term: 'Dup B',
                definition: 'Second.',
                aliases: [alias('shared')],
                isAcronym: false,
                path: null
              }
            ]
          }),
        /both resolve/
      )
    })

    test('importTerms() rejects a malformed payload', async () => {
      await assert.rejects(
        // @ts-expect-error -- deliberately malformed, matching what an external editor could hand back
        () => glossaryModel.importTerms(fixtures.siteId, { notTerms: [] }),
        /"terms" array/
      )
    })

    test('export -> import round-trips a glossary unchanged', async () => {
      await glossaryModel.importTerms(fixtures.siteId, {
        formatVersion: 2,
        terms: [
          {
            term: 'RoundTrip',
            definition: 'Stable.',
            aliases: [alias('RT')],
            isAcronym: false,
            path: null
          }
        ]
      })

      const exported = await glossaryModel.exportTerms(fixtures.siteId)
      await glossaryModel.importTerms(fixtures.siteId, exported)

      const after = await glossaryModel.exportTerms(fixtures.siteId)
      assert.deepEqual(after.terms, exported.terms)
    })
  })

  describe('versioning (OpenProject #1113)', () => {
    let glossaryActor: { id: string | null; name: string }

    before(() => {
      glossaryActor = { id: fixtures.userId, name: 'Test Admin' }
    })

    test('saveVersion() atomically replaces the glossary and records a version', async () => {
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'BeforeSave',
        definition: 'Will be replaced.'
      })

      const { terms, version } = await glossaryModel.saveVersion(
        fixtures.siteId,
        [
          { term: 'Saved One', definition: 'First.', aliases: [alias('S1')] },
          { term: 'Saved Two', definition: 'Second.' }
        ],
        glossaryActor
      )

      assert.equal(terms.length, 2)
      assert.equal(version.termCount, 2)
      assert.equal(version.actorName, 'Test Admin')

      const live = await glossaryModel.listTerms(fixtures.siteId)
      assert.deepEqual(live.map((t) => t.term).sort(), ['Saved One', 'Saved Two'])
    })

    test('saveVersion() rolls back the term replace too when recording the version fails (OpenProject #1113 "atomically")', async () => {
      const before = await glossaryModel.listTerms(fixtures.siteId)

      // -> A non-existent actorId trips glossaryVersions' FK constraint, forcing the version-record
      //    half of saveVersion() to fail. If the replace and the record are NOT sharing one
      //    transaction, the term replace below would already be committed by this point.
      await assert.rejects(() =>
        glossaryModel.saveVersion(
          fixtures.siteId,
          [{ term: 'ShouldNotStick', definition: 'Never actually saved.' }],
          { id: '00000000-0000-0000-0000-000000000000', name: 'Ghost Actor' }
        )
      )

      const after = await glossaryModel.listTerms(fixtures.siteId)
      assert.deepEqual(
        after.map((t) => t.id),
        before.map((t) => t.id)
      )
      assert.ok(!after.some((t) => t.term === 'ShouldNotStick'))
    })

    test('saveVersion() resolves a `path` to a pageId, the same shape importTerms takes (OpenProject #1112)', async () => {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: 'docs/save-version-target' }),
        actor
      )

      const { terms } = await glossaryModel.saveVersion(
        fixtures.siteId,
        [
          { term: 'SaveLinked', definition: 'Resolves via path.', path: 'docs/save-version-target' }
        ],
        glossaryActor
      )

      assert.equal(terms[0]!.pageId, page.id)
    })

    test('saveVersion() rejects an empty term, applying nothing', async () => {
      const before = await glossaryModel.listTerms(fixtures.siteId)

      await assert.rejects(
        () =>
          glossaryModel.saveVersion(
            fixtures.siteId,
            [{ term: '   ', definition: 'Bad.' }],
            glossaryActor
          ),
        /cannot be empty/
      )

      const after = await glossaryModel.listTerms(fixtures.siteId)
      assert.deepEqual(
        after.map((t) => t.id),
        before.map((t) => t.id)
      )
    })

    test('listVersions() returns most-recent-first summaries with no snapshot payload', async () => {
      await glossaryModel.saveVersion(
        fixtures.siteId,
        [{ term: 'ListVersionsA', definition: 'First save.' }],
        glossaryActor
      )
      await glossaryModel.saveVersion(
        fixtures.siteId,
        [{ term: 'ListVersionsB', definition: 'Second save.' }],
        glossaryActor
      )

      const versions = await glossaryModel.listVersions(fixtures.siteId)
      assert.ok(versions.length >= 2)
      assert.ok(
        Temporal.Instant.compare(
          versions[0]!.createdAt.toTemporalInstant(),
          versions[1]!.createdAt.toTemporalInstant()
        ) >= 0
      )
      assert.ok(!('snapshot' in versions[0]!))
    })

    test('getVersion() returns the full snapshot', async () => {
      const { version } = await glossaryModel.saveVersion(
        fixtures.siteId,
        [{ term: 'GetVersionTerm', definition: 'Snapshot me.', aliases: [alias('GVT')] }],
        glossaryActor
      )

      const fetched = await glossaryModel.getVersion(fixtures.siteId, version.id)
      assert.deepEqual(fetched?.snapshot.terms, [
        {
          term: 'GetVersionTerm',
          definition: 'Snapshot me.',
          aliases: [alias('GVT')],
          isAcronym: false,
          path: null
        }
      ])
    })

    test('getVersion() returns null for an id that does not exist', async () => {
      const fetched = await glossaryModel.getVersion(
        fixtures.siteId,
        '00000000-0000-0000-0000-000000000000'
      )
      assert.equal(fetched, null)
    })

    test('restoreVersion() applies the old term list AND records a new version, not rewriting history', async () => {
      const { version: v1 } = await glossaryModel.saveVersion(
        fixtures.siteId,
        [{ term: 'RestoreTarget', definition: 'From the past.' }],
        glossaryActor
      )
      await glossaryModel.saveVersion(
        fixtures.siteId,
        [{ term: 'RestoreLatest', definition: 'Current state.' }],
        glossaryActor
      )

      const { terms, version: v3 } = await glossaryModel.restoreVersion(
        fixtures.siteId,
        v1.id,
        glossaryActor
      )

      assert.deepEqual(
        terms.map((t) => t.term),
        ['RestoreTarget']
      )
      assert.notEqual(v3.id, v1.id)

      // -> The version restored FROM is untouched -- restoring is additive, not destructive.
      const originalStillThere = await glossaryModel.getVersion(fixtures.siteId, v1.id)
      assert.deepEqual(
        originalStillThere?.snapshot.terms.map((t) => t.term),
        ['RestoreTarget']
      )
    })

    test('restoreVersion() rejects an id that does not exist', async () => {
      await assert.rejects(
        () =>
          glossaryModel.restoreVersion(
            fixtures.siteId,
            '00000000-0000-0000-0000-000000000000',
            glossaryActor
          ),
        /does not exist/
      )
    })
  })

  describe('per-term CRUD versioning (OpenProject #1891)', () => {
    const versionActor = { id: null, name: 'Version Tester' }

    test('createTerm() with an actor appends a version snapshotting the resulting full term list', async () => {
      const before = await glossaryModel.listVersions(fixtures.siteId)
      const created = await glossaryModel.createTerm(
        fixtures.siteId,
        { term: 'VersionedCreate', definition: 'Should be versioned.' },
        versionActor
      )

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length + 1)
      const live = await glossaryModel.listTerms(fixtures.siteId)
      assert.equal(after[0]!.termCount, live.length)

      const snapshot = await glossaryModel.getVersion(fixtures.siteId, after[0]!.id)
      assert.ok(snapshot?.snapshot.terms.some((t) => t.term === created.term))
    })

    test('createTerm() without an actor records no version', async () => {
      const before = await glossaryModel.listVersions(fixtures.siteId)
      await glossaryModel.createTerm(fixtures.siteId, {
        term: 'UnversionedCreate',
        definition: 'No actor, no version.'
      })

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length)
    })

    test('updateTerm() with an actor appends a version', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'VersionedUpdateTarget',
        definition: 'Before.'
      })
      const before = await glossaryModel.listVersions(fixtures.siteId)

      await glossaryModel.updateTerm(
        fixtures.siteId,
        created.id,
        { definition: 'After.' },
        versionActor
      )

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length + 1)
    })

    test('updateTerm() without an actor records no version', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'UnversionedUpdateTarget',
        definition: 'Before.'
      })
      const before = await glossaryModel.listVersions(fixtures.siteId)

      await glossaryModel.updateTerm(fixtures.siteId, created.id, { definition: 'After.' })

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length)
    })

    test('updateTerm() records no version when the update fails (unknown id)', async () => {
      const before = await glossaryModel.listVersions(fixtures.siteId)

      await assert.rejects(() =>
        glossaryModel.updateTerm(
          fixtures.siteId,
          '00000000-0000-0000-0000-000000000000',
          { definition: 'Never applied.' },
          versionActor
        )
      )

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length)
    })

    test('deleteTerm() with an actor appends a version reflecting the term’s removal', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'VersionedDeleteTarget',
        definition: 'Will be removed.'
      })
      const before = await glossaryModel.listVersions(fixtures.siteId)

      await glossaryModel.deleteTerm(fixtures.siteId, created.id, versionActor)

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length + 1)
      const snapshot = await glossaryModel.getVersion(fixtures.siteId, after[0]!.id)
      assert.ok(!snapshot?.snapshot.terms.some((t) => t.term === 'VersionedDeleteTarget'))
    })

    test('deleteTerm() without an actor records no version', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'UnversionedDeleteTarget',
        definition: 'Will be removed, unattributed.'
      })
      const before = await glossaryModel.listVersions(fixtures.siteId)

      await glossaryModel.deleteTerm(fixtures.siteId, created.id)

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length)
    })

    test('deleteTerm() records no version when nothing was deleted', async () => {
      const before = await glossaryModel.listVersions(fixtures.siteId)

      await glossaryModel.deleteTerm(
        fixtures.siteId,
        '00000000-0000-0000-0000-000000000000',
        versionActor
      )

      const after = await glossaryModel.listVersions(fixtures.siteId)
      assert.equal(after.length, before.length)
    })
  })

  describe('audit log instrumentation (OpenProject #1115)', () => {
    let auditLogModel: typeof import('./auditLog.ts').auditLog
    const glossaryActor = { id: null, name: 'Audit Tester', ip: '127.0.0.1' }

    before(async () => {
      ;({ auditLog: auditLogModel } = await import('./auditLog.ts'))
    })

    test('createTerm() records a glossaryTerm.created entry only when an actor is given', async () => {
      const withoutActor = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AuditNoActor',
        definition: 'No actor passed.'
      })
      const withActor = await glossaryModel.createTerm(
        fixtures.siteId,
        { term: 'AuditWithActor', definition: 'Actor passed.' },
        glossaryActor
      )

      const { entries } = await auditLogModel.list({ event: 'glossaryTerm.created' })
      assert.ok(
        entries.some((e) => e.targetId === withActor.id && e.targetLabel === 'AuditWithActor')
      )
      assert.ok(!entries.some((e) => e.targetId === withoutActor.id))
    })

    test('updateTerm() records which fields changed', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AuditUpdateMe',
        definition: 'Before.'
      })

      await glossaryModel.updateTerm(
        fixtures.siteId,
        created.id,
        { definition: 'After.' },
        glossaryActor
      )

      const { entries } = await auditLogModel.list({ event: 'glossaryTerm.updated' })
      const entry = entries.find((e) => e.targetId === created.id)
      assert.deepEqual(entry?.detail.changedFields, ['definition'])
    })

    test('updateTerm() records aliases as changed when a term rename drops one, even though aliases wasn’t passed', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'Audit Hot Strip Mill',
        definition: 'A rolling mill.',
        aliases: [alias('Audit HSM')]
      })

      await glossaryModel.updateTerm(
        fixtures.siteId,
        created.id,
        { term: 'audit hsm' },
        glossaryActor
      )

      const { entries } = await auditLogModel.list({ event: 'glossaryTerm.updated' })
      const entry = entries.find((e) => e.targetId === created.id)
      assert.deepEqual(entry?.detail.changedFields, ['term', 'aliases'])
    })

    test('deleteTerm() records the deleted term’s label', async () => {
      const created = await glossaryModel.createTerm(fixtures.siteId, {
        term: 'AuditDeleteMe',
        definition: 'Gone soon.'
      })

      await glossaryModel.deleteTerm(fixtures.siteId, created.id, glossaryActor)

      const { entries } = await auditLogModel.list({ event: 'glossaryTerm.deleted' })
      const entry = entries.find((e) => e.targetId === created.id)
      assert.equal(entry?.targetLabel, 'AuditDeleteMe')
    })
  })
})
