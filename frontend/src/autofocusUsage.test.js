import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { listSourceFiles } from '../test/sourceFiles.js'

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Parses one tag starting at `text[start]` (`text[start] === '<'`), respecting quoted attribute
 * values so an embedded `>` (e.g. inside a JS expression like `:disabled="a > b"`) doesn't end the
 * tag early. Returns the tag name, its raw `<...>` slice (for attribute checks), and the index just
 * past the tag.
 */
function parseTag(text, start) {
  let j = start + 1
  const nameMatch = /[a-zA-Z0-9-]+/.exec(text.slice(j))
  const tagName = nameMatch[0]
  j += tagName.length
  let inQuote = null
  while (j < text.length) {
    const c = text[j]
    if (inQuote) {
      if (c === inQuote) inQuote = null
      j += 1
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c
      j += 1
      continue
    }
    if (c === '>') {
      return { tagName, attrs: text.slice(start, j + 1), endIndex: j + 1 }
    }
    j += 1
  }
  return { tagName, attrs: text.slice(start), endIndex: text.length }
}

function hasLiteralAutofocus(attrs) {
  return /(^|\s):?autofocus\b/.test(attrs)
}

/**
 * Finds every `<w-input>`/`<w-select>` tag in one file carrying a literal `autofocus` attribute, in a
 * file that also passes an `autofocus` option to `useDialogComponent` -- the specific "two mechanisms
 * wired for the same dialog" redundant-markup pattern this WP deleted.
 */
function findDuplicateWiring(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  if (!/useDialogComponent\s*\(\s*\{[^)]*autofocus\s*:/.test(text)) return []

  const tagRe = /<(w-input|w-select)\b/g
  const findings = []
  let match
  while ((match = tagRe.exec(text))) {
    const { tagName, attrs } = parseTag(text, match.index)
    if (hasLiteralAutofocus(attrs)) {
      const line = text.slice(0, match.index).split('\n').length
      findings.push({ file: path.relative(SRC_ROOT, filePath), line, tagName })
    }
  }
  return findings
}

describe('no dead <w-input>/<w-select> autofocus attribute duplicates useDialogComponent wiring', () => {
  it('finds no file that both calls useDialogComponent({ autofocus }) and carries a literal autofocus attribute on a w-input/w-select tag', () => {
    const files = listSourceFiles(SRC_ROOT, { ext: ['.vue'] })
    const findings = files.flatMap((f) => findDuplicateWiring(f))

    expect(findings, JSON.stringify(findings, null, 2)).toEqual([])
  })

  it('confirms the three originally-redundant dialogs no longer carry the dead template attribute', () => {
    const named = [
      'components/ApprovalRuleDialog.vue',
      'components/GlossaryTermDialog.vue',
      'components/SuggestionGuestDialog.vue'
    ]
    for (const rel of named) {
      const findings = findDuplicateWiring(path.join(SRC_ROOT, rel))
      expect(findings, `${rel}: ${JSON.stringify(findings)}`).toEqual([])
    }
  })
})
