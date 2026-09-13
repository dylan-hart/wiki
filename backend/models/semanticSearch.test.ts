import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  bestChunkPerPage,
  dedupeAndRank,
  HOP2_DISTANCE_PENALTY,
  HOP2_SEED_COUNT,
  mergeHopResults,
  search,
  selectHop2Seeds
} from './semanticSearch.ts'
import type { SemanticChunkMatch } from './semanticSearch.ts'

/**
 * Canned fixture builder — a chunk match with only the fields a given test cares about spelled out,
 * everything else defaulted so a test reads as "what distinguishes this row from its siblings".
 */
function makeMatch(
  overrides: Partial<SemanticChunkMatch> & { pageId: string; distance: number }
): SemanticChunkMatch {
  return {
    path: `/${overrides.pageId}`,
    locale: 'en',
    title: overrides.pageId,
    description: null,
    icon: null,
    tags: [],
    classification: null,
    chunkText: 'chunk text',
    chunkIndex: 0,
    embedding: [0, 0, 0],
    ...overrides
  }
}

describe('models/semanticSearch pure logic', () => {
  describe('bestChunkPerPage', () => {
    test('keeps only the lowest-distance chunk per page', () => {
      const rows = [
        makeMatch({ pageId: 'a', chunkIndex: 0, distance: 0.5 }),
        makeMatch({ pageId: 'a', chunkIndex: 1, distance: 0.2 }),
        makeMatch({ pageId: 'b', chunkIndex: 0, distance: 0.9 })
      ]
      const best = bestChunkPerPage(rows)
      assert.equal(best.size, 2)
      assert.equal(best.get('a')?.chunkIndex, 1)
      assert.equal(best.get('a')?.distance, 0.2)
      assert.equal(best.get('b')?.distance, 0.9)
    })

    test('empty input yields an empty map', () => {
      assert.equal(bestChunkPerPage([]).size, 0)
    })
  })

  describe('selectHop2Seeds', () => {
    test('picks the top HOP2_SEED_COUNT distinct pages by best distance', () => {
      const rows = [
        makeMatch({ pageId: 'a', distance: 0.3 }),
        makeMatch({ pageId: 'b', distance: 0.1 }),
        makeMatch({ pageId: 'c', distance: 0.2 }),
        makeMatch({ pageId: 'd', distance: 0.4 })
      ]
      const seeds = selectHop2Seeds(rows)
      assert.equal(seeds.length, HOP2_SEED_COUNT)
      assert.deepEqual(
        seeds.map((s) => s.pageId),
        ['b', 'c', 'a']
      )
    })

    test('fewer than the seed count of distinct pages yields fewer seeds, not padding', () => {
      const rows = [
        makeMatch({ pageId: 'a', distance: 0.1 }),
        makeMatch({ pageId: 'b', distance: 0.2 })
      ]
      const seeds = selectHop2Seeds(rows)
      assert.equal(seeds.length, 2)
    })

    test('a page with multiple chunks counts once, by its best chunk', () => {
      const rows = [
        makeMatch({ pageId: 'a', chunkIndex: 0, distance: 0.5 }),
        makeMatch({ pageId: 'a', chunkIndex: 1, distance: 0.1 })
      ]
      const seeds = selectHop2Seeds(rows, 3)
      assert.equal(seeds.length, 1)
      assert.equal(seeds[0]!.distance, 0.1)
    })
  })

  describe('dedupeAndRank', () => {
    test('an equal-distance hop-1 match beats a hop-2-only match (penalty applied)', () => {
      const hop1 = [makeMatch({ pageId: 'direct', distance: 0.3 })]
      const hop2 = [makeMatch({ pageId: 'related', distance: 0.3 })]
      const ranked = dedupeAndRank(hop1, hop2)
      assert.deepEqual(
        ranked.map((r) => r.pageId),
        ['direct', 'related']
      )
      assert.equal(ranked[0]!.hop, 1)
      assert.equal(ranked[0]!.distance, 0.3)
      assert.equal(ranked[1]!.hop, 2)
      // -> The reported `distance` stays the real, unpenalized value — only sort order is penalized.
      assert.equal(ranked[1]!.distance, 0.3)
    })

    test('a page in both hops reports hop: 1 with its real hop-1 distance, never hop-2-penalized', () => {
      const hop1 = [makeMatch({ pageId: 'both', distance: 0.4 })]
      const hop2 = [makeMatch({ pageId: 'both', distance: 0.05 })]
      const ranked = dedupeAndRank(hop1, hop2)
      assert.equal(ranked.length, 1)
      assert.equal(ranked[0]!.hop, 1)
      assert.equal(ranked[0]!.distance, 0.4)
    })

    test('a closer hop-2-only page can still outrank a farther hop-1 page once penalized', () => {
      const hop1 = [makeMatch({ pageId: 'direct', distance: 0.5 })]
      const hop2 = [makeMatch({ pageId: 'related', distance: 0.1 })]
      const ranked = dedupeAndRank(hop1, hop2)
      // 0.1 + HOP2_DISTANCE_PENALTY (0.1) = 0.2, still less than 0.5
      assert.deepEqual(
        ranked.map((r) => r.pageId),
        ['related', 'direct']
      )
      assert.equal(ranked[0]!.distance, 0.1)
    })

    test('the penalty is exactly HOP2_DISTANCE_PENALTY, not a hardcoded value', () => {
      const hop1: SemanticChunkMatch[] = []
      const hop2 = [
        makeMatch({ pageId: 'a', distance: 0.2 }),
        makeMatch({ pageId: 'b', distance: 0.2 + HOP2_DISTANCE_PENALTY + 0.01 })
      ]
      const ranked = dedupeAndRank(hop1, hop2)
      assert.deepEqual(
        ranked.map((r) => r.pageId),
        ['a', 'b']
      )
    })

    test('dedupes a page appearing multiple times within the same hop to its best chunk', () => {
      const hop1 = [
        makeMatch({ pageId: 'a', chunkIndex: 0, distance: 0.6 }),
        makeMatch({ pageId: 'a', chunkIndex: 2, distance: 0.15 })
      ]
      const ranked = dedupeAndRank(hop1, [])
      assert.equal(ranked.length, 1)
      assert.equal(ranked[0]!.chunkIndex, 2)
      assert.equal(ranked[0]!.distance, 0.15)
    })

    test('empty hop-1 and hop-2 input yields an empty ranked list', () => {
      assert.deepEqual(dedupeAndRank([], []), [])
    })

    test('carries the shaping fields a SearchResult-like consumer needs', () => {
      const hop1 = [
        makeMatch({
          pageId: 'p1',
          path: '/foo/bar',
          locale: 'fr',
          title: 'Foo Bar',
          description: 'a page',
          icon: 'mdi:file',
          chunkText: 'the matched passage',
          chunkIndex: 3,
          distance: 0.12
        })
      ]
      const [result] = dedupeAndRank(hop1, [])
      assert.deepEqual(result, {
        pageId: 'p1',
        path: '/foo/bar',
        locale: 'fr',
        title: 'Foo Bar',
        description: 'a page',
        icon: 'mdi:file',
        chunkText: 'the matched passage',
        chunkIndex: 3,
        distance: 0.12,
        hop: 1
      })
    })
  })

  describe('mergeHopResults', () => {
    function outcome(scanned: SemanticChunkMatch[], visible: SemanticChunkMatch[]) {
      return { scanned, visible }
    }

    test('applies offset/limit to the merged, ranked, deduped list', () => {
      const hop1Visible = [
        makeMatch({ pageId: 'a', distance: 0.1 }),
        makeMatch({ pageId: 'b', distance: 0.2 }),
        makeMatch({ pageId: 'c', distance: 0.3 })
      ]
      const result = mergeHopResults(outcome(hop1Visible, hop1Visible), outcome([], []), {
        offset: 1,
        limit: 1
      })
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]!.pageId, 'b')
    })

    test('totalHits is the deduped page count, not the raw chunk-row count', () => {
      const hop1Visible = [
        makeMatch({ pageId: 'a', chunkIndex: 0, distance: 0.1 }),
        makeMatch({ pageId: 'a', chunkIndex: 1, distance: 0.2 }),
        makeMatch({ pageId: 'b', distance: 0.3 })
      ]
      const result = mergeHopResults(outcome(hop1Visible, hop1Visible), outcome([], []), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHits, 2)
    })

    test('totalHitsApproximate is false when nothing scanned was filtered out, at either hop', () => {
      const rows = [makeMatch({ pageId: 'a', distance: 0.1 })]
      const result = mergeHopResults(outcome(rows, rows), outcome(rows, rows), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHitsApproximate, false)
    })

    test('totalHitsApproximate is true when hop 1 scanned more than survived filterVisible', () => {
      const scanned = [
        makeMatch({ pageId: 'a', distance: 0.1 }),
        makeMatch({ pageId: 'hidden', distance: 0.2 })
      ]
      const visible = [scanned[0]!]
      const result = mergeHopResults(outcome(scanned, visible), outcome([], []), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHitsApproximate, true)
    })

    test('totalHitsApproximate is true when hop 2 scanned more than survived filterVisible', () => {
      const scanned = [
        makeMatch({ pageId: 'a', distance: 0.1 }),
        makeMatch({ pageId: 'hidden', distance: 0.2 })
      ]
      const visible = [scanned[0]!]
      const result = mergeHopResults(outcome([], []), outcome(scanned, visible), {
        offset: 0,
        limit: 10
      })
      assert.equal(result.totalHitsApproximate, true)
    })

    test('suggestion is always null, matching toSearchPagesResult', () => {
      const result = mergeHopResults(outcome([], []), outcome([], []), { offset: 0, limit: 10 })
      assert.equal(result.suggestion, null)
      assert.deepEqual(result.results, [])
      assert.equal(result.totalHits, 0)
    })
  })

  describe('search', () => {
    test('degrades to an empty, non-approximate result set when embedding is unavailable', async () => {
      // -> `helpers/embeddings.ts` is a placeholder pending #3097 and always reports unavailable
      //    (`embedText` resolves `null`), so this exercises `search()`'s real degradation path with
      //    no `WIKI` global and no database at all.
      const result = await search('anything', undefined, 'site-1', 'en', { limit: 10, offset: 0 })
      assert.deepEqual(result, {
        results: [],
        totalHits: 0,
        totalHitsApproximate: false,
        suggestion: null
      })
    })
  })
})
