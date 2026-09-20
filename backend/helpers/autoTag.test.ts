import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildCases,
  loadCorpus,
  loadVectors,
  scoreKeywordsTermFrequency,
  selectTags,
  tally,
  addTallies
} from '../scripts/evaluate-auto-tag.ts'
import {
  AUTO_TAG_MAX_TAGS,
  AUTO_TAG_THRESHOLD,
  deriveAutoTags,
  tagTokens,
  tokenize
} from './autoTag.ts'

describe('tokenize and tagTokens', () => {
  test('lowercases, splits on non-alphanumerics, drops stopwords and single characters', () => {
    assert.deepEqual(tokenize('The Docker-Compose file, a B2 host!'), [
      'docker',
      'compose',
      'file',
      'b2',
      'host'
    ])
  })

  test('stems a trailing plural but keeps double-s words', () => {
    assert.deepEqual(tokenize('containers policies access'), ['container', 'policy', 'access'])
  })

  test('splits hyphenated and underscored tag names into their parts', () => {
    assert.deepEqual(tagTokens('on-call_rota'), ['call', 'rota'])
  })
})

describe('deriveAutoTags', () => {
  const page = {
    title: 'Docker images',
    text: 'Build the docker image in CI. The docker layer cache keeps builds fast.'
  }

  test('returns [] for an empty tag set', () => {
    assert.deepEqual(deriveAutoTags({ ...page, existingTags: [] }), [])
  })

  test('returns [] for a page with no usable words', () => {
    assert.deepEqual(deriveAutoTags({ title: '', text: '', existingTags: ['docker'] }), [])
    assert.deepEqual(
      deriveAutoTags({ title: 'the a', text: 'of to', existingTags: ['docker'] }),
      []
    )
  })

  test('returns [] when no tag clears the threshold', () => {
    assert.deepEqual(deriveAutoTags({ ...page, existingTags: ['kubernetes', 'sso', 'oncall'] }), [])
  })

  test('returns [] when a tag only barely appears against a dominant term', () => {
    const text = `${'docker '.repeat(30)} and one mention of sso`
    assert.deepEqual(deriveAutoTags({ title: 'x', text, existingTags: ['sso'] }), [])
  })

  test('returns a matching tag exactly as supplied, keeping its casing', () => {
    assert.deepEqual(deriveAutoTags({ ...page, existingTags: ['Docker', 'sso'] }), ['Docker'])
  })

  test('matches a plural in the page to a singular tag and the reverse', () => {
    assert.deepEqual(
      deriveAutoTags({ title: 'Images', text: 'images images', existingTags: ['image'] }),
      ['image']
    )
    assert.deepEqual(
      deriveAutoTags({ title: 'Image', text: 'image image', existingTags: ['images'] }),
      ['images']
    )
  })

  test('matches a hyphenated tag token by token and averages its parts', () => {
    const full = deriveAutoTags({
      title: 'Load balancer',
      text: 'load balancer setup for load balancer nodes',
      existingTags: ['load-balancer']
    })
    assert.deepEqual(full, ['load-balancer'])
    const half = deriveAutoTags(
      {
        title: 'balancer',
        text: 'balancer balancer balancer balancer load',
        existingTags: ['load-balancer']
      },
      { threshold: 0.9 }
    )
    assert.deepEqual(half, [])
  })

  test('orders by score then name and caps at three by default', () => {
    const tags = ['delta', 'charlie', 'bravo', 'alpha', 'echo']
    const text = 'alpha alpha alpha bravo bravo bravo charlie charlie delta delta echo echo'
    const result = deriveAutoTags({ title: '', text, existingTags: tags }, { threshold: 0.1 })
    assert.equal(result.length, AUTO_TAG_MAX_TAGS)
    assert.deepEqual(result, ['alpha', 'bravo', 'charlie'])
  })

  test('honours maxTags and threshold options', () => {
    const tags = ['alpha', 'bravo']
    const text = 'alpha alpha bravo'
    assert.deepEqual(deriveAutoTags({ title: '', text, existingTags: tags }, { maxTags: 1 }), [
      'alpha'
    ])
    assert.deepEqual(deriveAutoTags({ title: '', text, existingTags: tags }, { threshold: 0.75 }), [
      'alpha'
    ])
    assert.deepEqual(deriveAutoTags({ title: '', text, existingTags: tags }, { maxTags: 0 }), [])
  })

  test('never returns a tag with score zero even at threshold zero', () => {
    assert.deepEqual(
      deriveAutoTags({ title: 'a', text: 'alpha', existingTags: ['zeta'] }, { threshold: 0 }),
      []
    )
  })

  test('skips tag names with no usable tokens and de-duplicates the tag set', () => {
    assert.deepEqual(
      deriveAutoTags({ ...page, existingTags: ['the', 'x', '', 'docker', 'docker'] }),
      ['docker']
    )
  })

  test('counts the title twice against the body', () => {
    assert.deepEqual(
      deriveAutoTags({
        title: 'Runbook',
        text: 'paging '.repeat(10),
        existingTags: ['runbook', 'paging']
      }),
      ['paging', 'runbook']
    )
  })

  test('accepts the body as a list of chunks', () => {
    assert.deepEqual(
      deriveAutoTags({
        title: '',
        text: ['first chunk about paging', 'second chunk about paging'],
        existingTags: ['paging', 'chunk']
      }),
      ['chunk', 'paging']
    )
  })

  test('does not mutate its inputs', () => {
    const existingTags = ['docker', 'ci']
    const text = ['docker ci']
    deriveAutoTags({ title: 'docker', text, existingTags })
    assert.deepEqual(existingTags, ['docker', 'ci'])
    assert.deepEqual(text, ['docker ci'])
  })

  test('uses the threshold and cap recorded in the decision', () => {
    assert.equal(AUTO_TAG_THRESHOLD, 0.15)
    assert.equal(AUTO_TAG_MAX_TAGS, 3)
  })
})

describe('deriveAutoTags over the committed fixture', () => {
  const corpus = loadCorpus()
  const pages = new Map(corpus.wikis.flatMap((wiki) => wiki.pages.map((p) => [p.id, p])))
  const cases = buildCases(corpus, loadVectors())

  const derive = (id: string, existingTags: string[]) => {
    const source = pages.get(id)!
    return deriveAutoTags({ title: source.title, text: source.chunks, existingTags })
  }

  test('always returns a subset of the supplied tag set, at most three', () => {
    for (const c of cases) {
      const result = derive(c.target.id, c.candidateTags)
      assert.ok(result.length <= AUTO_TAG_MAX_TAGS)
      assert.equal(new Set(result).size, result.length)
      for (const tag of result) {
        assert.ok(c.candidateTags.includes(tag), `${c.target.id} returned ${tag}`)
      }
    }
  })

  test('returns [] for every page when given an empty tag set', () => {
    for (const c of cases) {
      assert.deepEqual(derive(c.target.id, []), [])
    }
  })

  test('returns [] for every page when the only candidates never appear on it', () => {
    for (const c of cases) {
      assert.deepEqual(derive(c.target.id, ['zzyzx', 'qwertyuiop']), [])
    }
  })

  test('picks exactly what the evaluation script picks at the recorded threshold', () => {
    for (const c of cases) {
      const expected = selectTags(
        scoreKeywordsTermFrequency(c),
        AUTO_TAG_THRESHOLD,
        AUTO_TAG_MAX_TAGS
      )
      assert.deepEqual(derive(c.target.id, c.candidateTags), expected, c.target.id)
    }
  })

  test('reproduces the recorded pooled result: 32 true positives, 11 false positives, 20 misses', () => {
    const total = cases.reduce(
      (sum, c) => addTallies(sum, tally(derive(c.target.id, c.candidateTags), c.expected)),
      { tp: 0, fp: 0, fn: 0 }
    )
    assert.deepEqual(total, { tp: 32, fp: 11, fn: 20 })
  })
})
