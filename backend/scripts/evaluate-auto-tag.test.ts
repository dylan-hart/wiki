import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { EMBEDDING_DIMENSIONS, MODEL_NAME } from '../helpers/embeddings.ts'
import {
  METHODS,
  addTallies,
  bestPlateau,
  bestRow,
  buildCases,
  cosine,
  documentFrequencies,
  evaluate,
  extractKeywords,
  hashText,
  isLiterallyMentioned,
  loadCorpus,
  loadVectors,
  meanVector,
  metricsOf,
  norm,
  recallByMention,
  scoreKeywords,
  scoreKeywordsTermFrequency,
  scoreNeighbourVotes,
  scoreNeighbourVotesWith,
  scoreTagNames,
  selectTags,
  serializeVectors,
  sweep,
  tagTokens,
  tally,
  tokenize
} from './evaluate-auto-tag.ts'
import type { Corpus, EvalCase, PreparedPage, VectorFile } from './evaluate-auto-tag.ts'

function page(overrides: Partial<PreparedPage> & { id: string }): PreparedPage {
  return {
    tokens: [],
    chunkVectors: [[1, 0]],
    meanVector: [1, 0],
    applied: [],
    gold: [],
    ...overrides
  }
}

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    wiki: 'w',
    target: page({ id: 'target' }),
    others: [],
    candidateTags: [],
    expected: [],
    tagVectors: new Map(),
    docFreq: new Map(),
    docCount: 1,
    ...overrides
  }
}

describe('vector helpers', () => {
  test('cosine is 1 for parallel, 0 for orthogonal and 0 for a zero vector', () => {
    assert.equal(cosine([1, 0], [2, 0]), 1)
    assert.equal(cosine([1, 0], [0, 3]), 0)
    assert.equal(cosine([0, 0], [1, 1]), 0)
  })

  test('meanVector averages and re-normalises to unit length', () => {
    const mean = meanVector([
      [1, 0],
      [0, 1]
    ])
    assert.ok(Math.abs(norm(mean) - 1) < 1e-12)
    assert.ok(Math.abs(mean[0] - Math.SQRT1_2) < 1e-12)
    assert.deepEqual(meanVector([]), [])
  })
})

describe('tokenization', () => {
  test('lowercases, drops stopwords and short tokens, and strips a plural s', () => {
    assert.deepEqual(tokenize('The Databases are BIG, and a x'), ['database', 'big'])
  })

  test('keeps double-s words and turns -ies into -y', () => {
    assert.deepEqual(tokenize('access queries'), ['access', 'query'])
  })

  test('splits a hyphenated tag name into its parts', () => {
    assert.deepEqual(tagTokens('release-notes'), ['release', 'note'])
  })

  test('a tag and a page mentioning it stem to the same token', () => {
    assert.deepEqual(tagTokens('kubernetes'), tokenize('Kubernetes'))
  })
})

describe('extractKeywords', () => {
  test('weights by term frequency and rarity and normalises to the strongest term', () => {
    const docFreq = new Map([
      ['common', 10],
      ['rare', 1]
    ])
    const keywords = extractKeywords(['common', 'common', 'rare'], docFreq, 10)
    const top = Math.max(...keywords.values())
    assert.equal(top, 1)
    assert.ok(keywords.get('rare')! > keywords.get('common')!)
  })

  test('honours the keyword limit', () => {
    const keywords = extractKeywords(['a1', 'b1', 'b1', 'c1', 'c1', 'c1'], new Map(), 1, 2)
    assert.deepEqual([...keywords.keys()], ['c1', 'b1'])
  })

  test('is empty for no tokens', () => {
    assert.equal(extractKeywords([], new Map(), 1).size, 0)
  })

  test('documentFrequencies counts each page once per token', () => {
    const frequencies = documentFrequencies([{ tokens: ['a', 'a', 'b'] }, { tokens: ['a'] }])
    assert.equal(frequencies.get('a'), 2)
    assert.equal(frequencies.get('b'), 1)
  })
})

describe('scoreKeywords', () => {
  test('scores a tag by how strongly its tokens rank among the page terms', () => {
    const target = page({ id: 't', tokens: ['docker', 'docker', 'image', 'build'] })
    const scores = scoreKeywords(evalCase({ target, candidateTags: ['docker', 'postgres'] }))
    assert.equal(scores.get('docker'), 1)
    assert.equal(scores.get('postgres'), 0)
  })

  test('a multi-token tag averages its parts', () => {
    const target = page({ id: 't', tokens: ['release', 'release', 'ship'] })
    const scores = scoreKeywords(evalCase({ target, candidateTags: ['release-notes'] }))
    assert.equal(scores.get('release-notes'), 0.5)
  })

  test('the term-frequency form ignores corpus statistics', () => {
    const target = page({ id: 't', tokens: ['alpha', 'alpha', 'beta'] })
    const scores = scoreKeywordsTermFrequency(
      evalCase({ target, candidateTags: ['alpha', 'beta'], docFreq: new Map([['alpha', 99]]) })
    )
    assert.equal(scores.get('alpha'), 1)
    assert.equal(scores.get('beta'), 0.5)
  })
})

describe('scoreTagNames', () => {
  test('scores each tag by cosine against the page mean vector, floored at zero', () => {
    const scores = scoreTagNames(
      evalCase({
        target: page({ id: 't', meanVector: [1, 0] }),
        candidateTags: ['near', 'far', 'opposite', 'unknown'],
        tagVectors: new Map([
          ['near', [1, 0]],
          ['far', [0, 1]],
          ['opposite', [-1, 0]]
        ])
      })
    )
    assert.equal(scores.get('near'), 1)
    assert.equal(scores.get('far'), 0)
    assert.equal(scores.get('opposite'), 0)
    assert.equal(scores.has('unknown'), false)
  })
})

describe('scoreNeighbourVotes', () => {
  const target = page({ id: 't', chunkVectors: [[1, 0]] })
  const near = page({ id: 'near', chunkVectors: [[1, 0]], applied: ['x'] })
  const mid = page({ id: 'mid', chunkVectors: [[0.6, 0.8]], applied: ['y'] })
  const untagged = page({ id: 'untagged', chunkVectors: [[0.6, 0.8]] })

  test('weights each neighbouring page by similarity and normalises by total weight', () => {
    const scores = scoreNeighbourVotes(
      evalCase({ target, others: [near, mid], candidateTags: ['x', 'y'] })
    )
    assert.ok(Math.abs(scores.get('x')! - 1 / 1.6) < 1e-12)
    assert.ok(Math.abs(scores.get('y')! - 0.6 / 1.6) < 1e-12)
  })

  test('untagged neighbours dilute the vote', () => {
    const scores = scoreNeighbourVotes(
      evalCase({ target, others: [near, untagged], candidateTags: ['x'] })
    )
    assert.ok(scores.get('x')! < 1 / 1.6 + 1e-12)
  })

  test('only the nearest pages vote', () => {
    const scores = scoreNeighbourVotesWith(1)(
      evalCase({ target, others: [near, mid], candidateTags: ['x', 'y'] })
    )
    assert.equal(scores.get('x'), 1)
    assert.equal(scores.get('y'), 0)
  })

  test('scores zero everywhere when there are no neighbours', () => {
    const scores = scoreNeighbourVotes(evalCase({ target, others: [], candidateTags: ['x'] }))
    assert.equal(scores.get('x'), 0)
  })
})

describe('selectTags', () => {
  const scores = new Map([
    ['b', 0.6],
    ['a', 0.6],
    ['c', 0.3],
    ['d', 0.05]
  ])

  test('keeps tags at or above the threshold, best first, ties by name', () => {
    assert.deepEqual(selectTags(scores, 0.3, 5), ['a', 'b', 'c'])
  })

  test('caps the number of tags', () => {
    assert.deepEqual(selectTags(scores, 0.1, 2), ['a', 'b'])
  })

  test('returns nothing when no score reaches the threshold', () => {
    assert.deepEqual(selectTags(scores, 0.9), [])
  })
})

describe('tally and metrics', () => {
  test('counts true positives, false positives and misses', () => {
    assert.deepEqual(tally(['a', 'b', 'x'], ['a', 'b', 'c']), { tp: 2, fp: 1, fn: 1 })
  })

  test('duplicates in the prediction count once', () => {
    assert.deepEqual(tally(['a', 'a'], ['a']), { tp: 1, fp: 0, fn: 0 })
  })

  test('tallies add', () => {
    assert.deepEqual(addTallies({ tp: 1, fp: 2, fn: 3 }, { tp: 4, fp: 5, fn: 6 }), {
      tp: 5,
      fp: 7,
      fn: 9
    })
  })

  test('precision, recall and the precision-weighted F', () => {
    const { precision, recall, f } = metricsOf({ tp: 3, fp: 1, fn: 3 })
    assert.equal(precision, 0.75)
    assert.equal(recall, 0.5)
    assert.ok(Math.abs(f - (1.25 * 0.75 * 0.5) / (0.25 * 0.75 + 0.5)) < 1e-12)
    assert.ok(f > (2 * 0.75 * 0.5) / (0.75 + 0.5) - 1e-12 && f < 0.75)
  })

  test('a beta of 1 is the ordinary F1', () => {
    const { f } = metricsOf({ tp: 3, fp: 1, fn: 3 }, 1)
    assert.ok(Math.abs(f - (2 * 0.75 * 0.5) / 1.25) < 1e-12)
  })

  test('no predictions and no expectations score zero rather than NaN', () => {
    assert.deepEqual(metricsOf({ tp: 0, fp: 0, fn: 0 }), { precision: 0, recall: 0, f: 0 })
    assert.deepEqual(metricsOf({ tp: 0, fp: 2, fn: 1 }), { precision: 0, recall: 0, f: 0 })
  })
})

describe('evaluate, sweep and bestRow over a small hand-made wiki', () => {
  const vectorFor: Record<string, number[]> = {
    'alpha one': [1, 0],
    'alpha two': [0.9, 0.436],
    'beta one': [0, 1],
    'gamma one': [-1, 0],
    alpha: [1, 0],
    beta: [0, 1]
  }
  const corpus: Corpus = {
    wikis: [
      {
        name: 'tiny',
        pages: [
          { id: 'p1', title: 'alpha', chunks: ['alpha one'], gold: ['alpha'] },
          { id: 'p2', title: 'alpha', chunks: ['alpha two'], gold: ['alpha'] },
          { id: 'p3', title: 'beta', chunks: ['beta one'], gold: ['beta'] },
          { id: 'p4', title: 'nothing', chunks: ['gamma one'], gold: [] },
          {
            id: 'p5',
            title: 'skipped',
            chunks: ['alpha one'],
            gold: ['alpha'],
            evaluate: false
          }
        ]
      }
    ]
  }
  const vectorFile: VectorFile = {
    model: MODEL_NAME,
    dimensions: 2,
    vectors: Object.fromEntries(Object.entries(vectorFor).map(([k, v]) => [hashText(k), v]))
  }
  const cases = buildCases(corpus, vectorFile)

  test('skips pages marked evaluate: false and evaluates the rest leave-one-out', () => {
    assert.deepEqual(
      cases.map((c) => c.target.id),
      ['p1', 'p2', 'p3', 'p4']
    )
  })

  test('candidate tags come from the other pages and expected tags are limited to them', () => {
    const [p1, , , p4] = cases
    assert.deepEqual(p1.candidateTags, ['alpha', 'beta'])
    assert.deepEqual(p1.expected, ['alpha'])
    assert.deepEqual(p4.expected, [])
  })

  test('a tag held only by the target page is not a candidate', () => {
    const p3 = cases[2]
    assert.equal(p3.candidateTags.includes('beta'), false)
    assert.deepEqual(p3.expected, [])
  })

  test('tag-name ranking recovers the alpha pages at a sensible threshold', () => {
    const tallies = evaluate(scoreTagNames, cases, 0.5)
    assert.deepEqual(tallies, { tp: 2, fp: 0, fn: 0 })
  })

  test('sweep reports pooled and per-wiki metrics and counts empty-page false positives', () => {
    const rows = sweep(scoreTagNames, cases, [0.1, 0.5, 0.99])
    assert.equal(rows.length, 3)
    assert.deepEqual(Object.keys(rows[0].byWiki), ['tiny'])
    assert.equal(rows[1].pooled.precision, 1)
    assert.equal(rows[2].pooled.recall, 0.5)
    assert.equal(rows[0].emptyPageFalsePositives >= rows[2].emptyPageFalsePositives, true)
  })

  test('bestRow takes the highest F and bestPlateau spans the tied thresholds', () => {
    const rows = sweep(scoreTagNames, cases, [0.1, 0.5, 0.6, 0.99])
    const best = bestRow(rows)
    assert.equal(best.pooled.f, Math.max(...rows.map((row) => row.pooled.f)))
    const [low, high] = bestPlateau(rows)
    assert.ok(low <= best.threshold && best.threshold <= high)
  })

  test('a missing precomputed vector is reported, not silently zeroed', () => {
    assert.throws(
      () => buildCases(corpus, { ...vectorFile, vectors: {} }),
      /no precomputed vector for a chunk of p1/
    )
  })

  test('literal mention and recall split by it', () => {
    const target = page({ id: 't', tokens: tokenize('docker compose') })
    assert.equal(isLiterallyMentioned('docker', target), true)
    assert.equal(isLiterallyMentioned('kubernetes', target), false)
    const split = recallByMention(
      scoreKeywords,
      [
        evalCase({
          target,
          candidateTags: ['docker', 'kubernetes'],
          expected: ['docker', 'kubernetes']
        })
      ],
      0.1
    )
    assert.deepEqual(split, {
      mentioned: { found: 1, total: 1 },
      unmentioned: { found: 0, total: 1 }
    })
  })
})

describe('serializeVectors', () => {
  test('round-trips through JSON with one vector per line', () => {
    const file: VectorFile = { model: 'm', dimensions: 2, vectors: { b: [0.5, 1], a: [0, -1] } }
    const text = serializeVectors(file)
    assert.deepEqual(JSON.parse(text), file)
    assert.ok(text.indexOf('"a"') < text.indexOf('"b"'))
    assert.ok(text.endsWith('\n'))
  })
})

describe('the committed fixture', () => {
  const corpus = loadCorpus()
  const vectors = loadVectors()

  test('was embedded with the model the app uses, at its dimension', () => {
    assert.equal(vectors.model, MODEL_NAME)
    assert.equal(vectors.dimensions, EMBEDDING_DIMENSIONS)
    for (const vector of Object.values(vectors.vectors)) {
      assert.equal(vector.length, EMBEDDING_DIMENSIONS)
      assert.ok(Math.abs(norm(vector) - 1) < 1e-3)
    }
  })

  test('has a vector for exactly the chunks and tags in the corpus, so none is stale', () => {
    const texts = new Set<string>()
    for (const wiki of corpus.wikis) {
      for (const p of wiki.pages) {
        p.chunks.forEach((chunk) => texts.add(chunk))
        ;(p.applied ?? p.gold).forEach((tag) => texts.add(tag))
      }
    }
    const expected = [...texts].map(hashText).sort()
    assert.deepEqual(Object.keys(vectors.vectors).sort(), expected)
  })

  test('covers a dense and a sparse wiki with empty-gold negatives in each', () => {
    assert.deepEqual(
      corpus.wikis.map((wiki) => wiki.name),
      ['dense', 'sparse']
    )
    for (const wiki of corpus.wikis) {
      assert.ok(wiki.pages.some((p) => p.gold.length === 0))
    }
    const sparse = corpus.wikis[1].pages
    const tagged = sparse.filter((p) => (p.applied ?? p.gold).length > 0)
    assert.ok(tagged.length < sparse.length / 2)
  })

  test('page ids are unique and every applied tag is also a gold tag', () => {
    const ids = corpus.wikis.flatMap((wiki) => wiki.pages.map((p) => p.id))
    assert.equal(new Set(ids).size, ids.length)
    for (const wiki of corpus.wikis) {
      for (const p of wiki.pages) {
        for (const tag of p.applied ?? p.gold) {
          assert.ok(p.gold.includes(tag), `${p.id} applies ${tag} it would not be given`)
        }
      }
    }
  })

  test('every method scores every candidate tag between 0 and 1 for every page', () => {
    const cases = buildCases(corpus, vectors)
    assert.ok(cases.length >= 30)
    for (const { scorer, name } of METHODS) {
      for (const c of cases) {
        for (const [tag, score] of scorer(c)) {
          assert.ok(score >= 0 && score <= 1 + 1e-9, `${name} ${c.target.id} ${tag} ${score}`)
        }
      }
    }
  })

  test('the recorded choice: term-frequency keyword matching leads every method on pooled F0.5', () => {
    const cases = buildCases(corpus, vectors)
    const best = new Map(
      METHODS.map(({ name, scorer }) => [name, bestRow(sweep(scorer, cases)).pooled.f])
    )
    const chosen = best.get('keyword-extraction-tf')!
    for (const [name, f] of best) {
      if (name !== 'keyword-extraction-tf' && name !== 'keyword-extraction') {
        assert.ok(chosen > f, `${name} ${f} should trail ${chosen}`)
      }
    }
    assert.deepEqual(evaluate(scoreKeywordsTermFrequency, cases, 0.15), {
      tp: 32,
      fp: 11,
      fn: 20
    })
  })

  test('neighbour voting is the only method with signal where the tag word is absent, and it is weak', () => {
    const cases = buildCases(corpus, vectors)
    const voting = recallByMention(scoreNeighbourVotes, cases, 0.25)
    const keyword = recallByMention(scoreKeywordsTermFrequency, cases, 0.15)
    assert.equal(keyword.unmentioned.found, 0)
    assert.ok(voting.unmentioned.found > 0)
  })
})
