import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import { MODEL_NAME, EMBEDDING_DIMENSIONS, extractEmbedding } from '../helpers/embeddings.ts'
import type { FeatureExtractor } from '../helpers/embeddings.ts'
import { tagTokens, tokenize } from '../helpers/autoTag.ts'

export { tagTokens, tokenize }

export interface FixturePage {
  id: string
  title: string
  chunks: string[]
  gold: string[]
  applied?: string[]
  evaluate?: boolean
}

export interface FixtureWiki {
  name: string
  pages: FixturePage[]
}

export interface Corpus {
  wikis: FixtureWiki[]
}

export interface VectorFile {
  model: string
  dimensions: number
  vectors: Record<string, number[]>
}

export interface PreparedPage {
  id: string
  tokens: string[]
  chunkVectors: number[][]
  meanVector: number[]
  applied: string[]
  gold: string[]
}

export interface EvalCase {
  wiki: string
  target: PreparedPage
  others: PreparedPage[]
  candidateTags: string[]
  expected: string[]
  tagVectors: Map<string, number[]>
  docFreq: Map<string, number>
  docCount: number
}

export type Scorer = (evalCase: EvalCase) => Map<string, number>

export interface Tally {
  tp: number
  fp: number
  fn: number
}

export interface Metrics {
  precision: number
  recall: number
  f: number
}

export const NEIGHBOUR_PAGES = 5
export const MAX_TAGS = 3
export const KEYWORD_LIMIT = Number.POSITIVE_INFINITY
export const F_BETA = 0.5
export const THRESHOLDS = Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100)

const FIXTURE_DIR = new URL('./evaluate-auto-tag-fixtures/', import.meta.url)
const CORPUS_PATH = new URL('corpus.json', FIXTURE_DIR)
const VECTORS_PATH = new URL('vectors.json', FIXTURE_DIR)

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i]
  }
  return sum
}

export function norm(a: number[]): number {
  return Math.sqrt(dot(a, a))
}

export function cosine(a: number[], b: number[]): number {
  const denominator = norm(a) * norm(b)
  return denominator === 0 ? 0 : dot(a, b) / denominator
}

export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    return []
  }
  const sum = Array.from({ length: vectors[0].length }, () => 0)
  for (const vector of vectors) {
    for (let i = 0; i < sum.length; i++) {
      sum[i] += vector[i]
    }
  }
  const length = norm(sum)
  return length === 0 ? sum : sum.map((value) => value / length)
}

export function documentFrequencies(pages: { tokens: string[] }[]): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const page of pages) {
    for (const token of new Set(page.tokens)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    }
  }
  return frequencies
}

export function extractKeywords(
  tokens: string[],
  docFreq: Map<string, number>,
  docCount: number,
  limit = KEYWORD_LIMIT
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  const weighted = [...counts.entries()]
    .map(([token, count]) => {
      const idf = Math.log(1 + docCount / (docFreq.get(token) ?? 1))
      return [token, count * idf] as const
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
  const top = weighted[0]?.[1] ?? 0
  return new Map(top === 0 ? [] : weighted.map(([token, weight]) => [token, weight / top]))
}

export const scoreKeywords: Scorer = ({ target, candidateTags, docFreq, docCount }) => {
  const keywords = extractKeywords(target.tokens, docFreq, docCount)
  const scores = new Map<string, number>()
  for (const tag of candidateTags) {
    const parts = tagTokens(tag)
    if (parts.length === 0) {
      continue
    }
    const total = parts.reduce((sum, part) => sum + (keywords.get(part) ?? 0), 0)
    scores.set(tag, total / parts.length)
  }
  return scores
}

export const scoreTagNames: Scorer = ({ target, candidateTags, tagVectors }) => {
  const scores = new Map<string, number>()
  for (const tag of candidateTags) {
    const vector = tagVectors.get(tag)
    if (vector) {
      scores.set(tag, Math.max(0, cosine(target.meanVector, vector)))
    }
  }
  return scores
}

export function bestChunkSimilarity(a: number[][], b: number[][]): number {
  let best = -1
  for (const left of a) {
    for (const right of b) {
      const similarity = cosine(left, right)
      if (similarity > best) {
        best = similarity
      }
    }
  }
  return best
}

export function scoreNeighbourVotesWith(neighbourPages: number): Scorer {
  return ({ target, others, candidateTags }) => {
    const neighbours = others
      .map((page) => ({
        page,
        similarity: Math.max(0, bestChunkSimilarity(target.chunkVectors, page.chunkVectors))
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, neighbourPages)
    const totalWeight = neighbours.reduce((sum, item) => sum + item.similarity, 0)
    const scores = new Map<string, number>()
    for (const tag of candidateTags) {
      const votes = neighbours
        .filter((item) => item.page.applied.includes(tag))
        .reduce((sum, item) => sum + item.similarity, 0)
      scores.set(tag, totalWeight === 0 ? 0 : votes / totalWeight)
    }
    return scores
  }
}

export const scoreNeighbourVotes: Scorer = scoreNeighbourVotesWith(NEIGHBOUR_PAGES)

export const scoreKeywordsTermFrequency: Scorer = (evalCase) =>
  scoreKeywords({ ...evalCase, docFreq: new Map(), docCount: 1 })

export const METHODS: { name: string; scorer: Scorer }[] = [
  { name: 'neighbour-voting', scorer: scoreNeighbourVotes },
  { name: 'tag-name-ranking', scorer: scoreTagNames },
  { name: 'keyword-extraction', scorer: scoreKeywords },
  { name: 'keyword-extraction-tf', scorer: scoreKeywordsTermFrequency }
]

export function selectTags(
  scores: Map<string, number>,
  threshold: number,
  maxTags = MAX_TAGS
): string[] {
  return [...scores.entries()]
    .filter(([, score]) => score >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTags)
    .map(([tag]) => tag)
}

export function tally(predicted: string[], expected: string[]): Tally {
  const expectedSet = new Set(expected)
  const predictedSet = new Set(predicted)
  let tp = 0
  for (const tag of predictedSet) {
    if (expectedSet.has(tag)) {
      tp++
    }
  }
  return { tp, fp: predictedSet.size - tp, fn: expectedSet.size - tp }
}

export function addTallies(a: Tally, b: Tally): Tally {
  return { tp: a.tp + b.tp, fp: a.fp + b.fp, fn: a.fn + b.fn }
}

export function metricsOf({ tp, fp, fn }: Tally, beta = F_BETA): Metrics {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const denominator = beta * beta * precision + recall
  const f = denominator === 0 ? 0 : ((1 + beta * beta) * precision * recall) / denominator
  return { precision, recall, f }
}

function prepare(page: FixturePage, vectors: Map<string, number[]>): PreparedPage {
  const chunkVectors = page.chunks.map((chunk) => {
    const vector = vectors.get(hashText(chunk))
    if (!vector) {
      throw new Error(`no precomputed vector for a chunk of ${page.id}; run with --regenerate`)
    }
    return vector
  })
  return {
    id: page.id,
    tokens: tokenize([page.title, page.title, ...page.chunks].join(' ')),
    chunkVectors,
    meanVector: meanVector(chunkVectors),
    applied: page.applied ?? page.gold,
    gold: page.gold
  }
}

export function buildCases(corpus: Corpus, vectorFile: VectorFile): EvalCase[] {
  const vectors = new Map(Object.entries(vectorFile.vectors))
  const cases: EvalCase[] = []
  for (const wiki of corpus.wikis) {
    const prepared = wiki.pages.map((page) => prepare(page, vectors))
    const docFreq = documentFrequencies(prepared)
    const allTags = new Set(prepared.flatMap((page) => page.applied))
    const tagVectors = new Map<string, number[]>()
    for (const tag of allTags) {
      const vector = vectors.get(hashText(tag))
      if (!vector) {
        throw new Error(`no precomputed vector for tag "${tag}"; run with --regenerate`)
      }
      tagVectors.set(tag, vector)
    }
    wiki.pages.forEach((page, index) => {
      if (page.evaluate === false) {
        return
      }
      const others = prepared.filter((_, other) => other !== index)
      const candidateTags = [...new Set(others.flatMap((other) => other.applied))].sort()
      cases.push({
        wiki: wiki.name,
        target: prepared[index],
        others,
        candidateTags,
        expected: page.gold.filter((tag) => candidateTags.includes(tag)),
        tagVectors,
        docFreq,
        docCount: prepared.length
      })
    })
  }
  return cases
}

export function evaluate(
  scorer: Scorer,
  cases: EvalCase[],
  threshold: number,
  maxTags = MAX_TAGS
): Tally {
  return cases.reduce(
    (sum, evalCase) =>
      addTallies(sum, tally(selectTags(scorer(evalCase), threshold, maxTags), evalCase.expected)),
    { tp: 0, fp: 0, fn: 0 }
  )
}

export interface SweepRow {
  threshold: number
  pooled: Metrics
  byWiki: Record<string, Metrics>
  emptyPageFalsePositives: number
}

export function sweep(
  scorer: Scorer,
  cases: EvalCase[],
  thresholds = THRESHOLDS,
  maxTags = MAX_TAGS
): SweepRow[] {
  const wikis = [...new Set(cases.map((evalCase) => evalCase.wiki))]
  const negatives = cases.filter((evalCase) => evalCase.target.gold.length === 0)
  return thresholds.map((threshold) => {
    const byWiki: Record<string, Metrics> = {}
    for (const wiki of wikis) {
      const subset = cases.filter((evalCase) => evalCase.wiki === wiki)
      byWiki[wiki] = metricsOf(evaluate(scorer, subset, threshold, maxTags))
    }
    return {
      threshold,
      pooled: metricsOf(evaluate(scorer, cases, threshold, maxTags)),
      byWiki,
      emptyPageFalsePositives: negatives.filter(
        (evalCase) => selectTags(scorer(evalCase), threshold, maxTags).length > 0
      ).length
    }
  })
}

export function bestRow(rows: SweepRow[]): SweepRow {
  return rows.reduce((best, row) => (row.pooled.f > best.pooled.f ? row : best))
}

export function bestPlateau(rows: SweepRow[]): [number, number] {
  const best = bestRow(rows)
  const tied = rows.filter((row) => Math.abs(row.pooled.f - best.pooled.f) < 1e-9)
  return [tied[0].threshold, tied[tied.length - 1].threshold]
}

export function isLiterallyMentioned(tag: string, target: PreparedPage): boolean {
  const parts = tagTokens(tag)
  return parts.length > 0 && parts.every((part) => target.tokens.includes(part))
}

export interface PresenceSplit {
  mentioned: { found: number; total: number }
  unmentioned: { found: number; total: number }
}

export function recallByMention(
  scorer: Scorer,
  cases: EvalCase[],
  threshold: number,
  maxTags = MAX_TAGS
): PresenceSplit {
  const split: PresenceSplit = {
    mentioned: { found: 0, total: 0 },
    unmentioned: { found: 0, total: 0 }
  }
  for (const evalCase of cases) {
    const predicted = new Set(selectTags(scorer(evalCase), threshold, maxTags))
    for (const tag of evalCase.expected) {
      const bucket = isLiterallyMentioned(tag, evalCase.target)
        ? split.mentioned
        : split.unmentioned
      bucket.total++
      if (predicted.has(tag)) {
        bucket.found++
      }
    }
  }
  return split
}

export async function regenerateVectors(
  corpus: Corpus,
  extract: FeatureExtractor
): Promise<VectorFile> {
  const texts = new Set<string>()
  for (const wiki of corpus.wikis) {
    for (const page of wiki.pages) {
      page.chunks.forEach((chunk) => texts.add(chunk))
      ;(page.applied ?? page.gold).forEach((tag) => texts.add(tag))
    }
  }
  const vectors: Record<string, number[]> = {}
  for (const text of [...texts].sort()) {
    const embedding = await extractEmbedding(text, extract)
    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`could not embed "${text.slice(0, 40)}"`)
    }
    vectors[hashText(text)] = embedding.map((value) => Math.round(value * 1e5) / 1e5)
  }
  return { model: MODEL_NAME, dimensions: EMBEDDING_DIMENSIONS, vectors }
}

export function serializeVectors(file: VectorFile): string {
  const lines = Object.entries(file.vectors)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, vector]) => `    ${JSON.stringify(key)}: [${vector.join(',')}]`)
  return (
    `{\n  "model": ${JSON.stringify(file.model)},\n  "dimensions": ${file.dimensions},\n` +
    `  "vectors": {\n${lines.join(',\n')}\n  }\n}\n`
  )
}

export function loadCorpus(): Corpus {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus
}

export function loadVectors(): VectorFile {
  return JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as VectorFile
}

const pct = (value: number) => (value * 100).toFixed(1).padStart(5)

function formatRow(row: SweepRow): string {
  const wikiColumns = Object.entries(row.byWiki)
    .map(([wiki, m]) => `${wiki} P ${pct(m.precision)} R ${pct(m.recall)}`)
    .join(' | ')
  return (
    `  ${row.threshold.toFixed(2)}  P ${pct(row.pooled.precision)}  R ${pct(row.pooled.recall)}` +
    `  F0.5 ${pct(row.pooled.f)}  | ${wikiColumns} | empty-page FP ${row.emptyPageFalsePositives}`
  )
}

export function report(cases: EvalCase[]): string {
  const expectedTotal = cases.reduce((sum, evalCase) => sum + evalCase.expected.length, 0)
  const lines = [
    `Model ${MODEL_NAME}; ${cases.length} evaluated pages, ${expectedTotal} expected tags, ` +
      `at most ${MAX_TAGS} tags per page, neighbour vote over ${NEIGHBOUR_PAGES} pages.`,
    ''
  ]
  const summary: string[] = []
  for (const { name, scorer } of METHODS) {
    const rows = sweep(scorer, cases)
    const best = bestRow(rows)
    lines.push(`== ${name} ==`, ...rows.map(formatRow), '')
    const split = recallByMention(scorer, cases, best.threshold)
    const [low, high] = bestPlateau(rows)
    summary.push(
      `${name.padEnd(22)} threshold ${best.threshold.toFixed(2)} (tied ${low.toFixed(2)}-${high.toFixed(2)})` +
        `  P ${pct(best.pooled.precision)}` +
        `  R ${pct(best.pooled.recall)}  F0.5 ${pct(best.pooled.f)}` +
        `  | recall when the tag word is on the page ${split.mentioned.found}/${split.mentioned.total}` +
        `, when it is not ${split.unmentioned.found}/${split.unmentioned.total}`
    )
  }
  lines.push('Best pooled F0.5 per method', ...summary)
  return lines.join('\n')
}

async function loadRealExtractor(): Promise<FeatureExtractor> {
  const specifier = '@huggingface/transformers'
  const { pipeline } = await import(specifier)
  return (await pipeline('feature-extraction', MODEL_NAME)) as FeatureExtractor
}

async function main() {
  const corpus = loadCorpus()
  if (process.argv.includes('--regenerate')) {
    ;(globalThis as any).CARDINAL = {
      logger: { warn: (_scope: string, message: string) => process.stderr.write(`${message}\n`) }
    }
    const file = await regenerateVectors(corpus, await loadRealExtractor())
    writeFileSync(VECTORS_PATH, serializeVectors(file))
    process.stdout.write(`wrote ${Object.keys(file.vectors).length} vectors for ${MODEL_NAME}\n`)
    return
  }
  process.stdout.write(`${report(buildCases(corpus, loadVectors()))}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
