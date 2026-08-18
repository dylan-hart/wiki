// Structural test for docs/variances.md — this file is pure documentation, so there is no
// application code to unit test. Instead this verifies the discipline this task establishes:
// a short header stating the citable rule (linking back to CLAUDE.md rather than re-explaining
// it) and a per-entry template with the four required fields. Run directly:
//   node --test docs/variances.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'variances.md')

describe('docs/variances.md', () => {
  const content = readFileSync(filePath, 'utf8')
  const lines = content.split('\n')

  test('exists and is non-empty', () => {
    assert.ok(content.trim().length > 0)
  })

  const headerEnd = lines.findIndex((line) => /^##\s/.test(line))
  const header = lines.slice(0, headerEnd === -1 ? lines.length : headerEnd).join('\n')

  test('header states entries exist only for genuine, justified deviations', () => {
    assert.match(header, /genuine/i)
    assert.match(header, /justified/i)
  })

  test('header states an entry is not cover for a fixable lint/type/behavior bug', () => {
    assert.match(header, /fixable/i)
  })

  test('header states an entry is deleted once resolved, not left as changelog prose', () => {
    assert.match(header, /delete/i)
    assert.match(header, /resolved/i)
    assert.match(header, /changelog prose/i)
  })

  test('header is short (3-6 sentences) and links back to CLAUDE.md rather than re-explaining it', () => {
    const sentenceCount = (header.match(/[.!?](?:\s|$)/g) || []).length
    assert.ok(
      sentenceCount >= 3 && sentenceCount <= 6,
      `expected 3-6 sentences, got ${sentenceCount}`
    )
    assert.match(header, /CLAUDE\.md/)
    // Should not duplicate the actual rule text out of the root CLAUDE.md's
    // "variances.md Discipline" section — a link, not a restatement.
    assert.doesNotMatch(header, /warnings are treated as failures/i)
    assert.doesNotMatch(header, /economically fixable/i)
  })

  test('defines a per-entry template with all four required fields', () => {
    const templateStart = content.indexOf('## Entry template')
    assert.notEqual(templateStart, -1, 'expected an "## Entry template" section')
    const entriesStart = content.indexOf('## Entries')
    assert.notEqual(entriesStart, -1, 'expected an "## Entries" section')
    assert.ok(entriesStart > templateStart, 'Entries section should follow the template section')

    const template = content.slice(templateStart, entriesStart)
    assert.match(template, /what deviates/i)
    assert.match(template, /why it'?s justified/i)
    assert.match(template, /cost/i)
    assert.match(template, /resolved/i)
  })

  test('ships with no populated entries — this task produces structure only', () => {
    const entriesStart = content.indexOf('## Entries')
    const entriesSection = content.slice(entriesStart)
    // No "### " entry headings should exist yet under Entries.
    assert.doesNotMatch(entriesSection, /\n### /)
  })
})
