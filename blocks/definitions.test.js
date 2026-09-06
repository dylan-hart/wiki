import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Cross-block structural check, not a per-block behavioral one (those live alongside each block, at
 * `component.test.js`).
 *
 * `frontend/src/helpers/blocks.js#blockMarkdown()` wraps a block's `definition.template` in its own
 * `::block-<name>{…}` / `::` fence (bumped to `:::` when the template itself contains a `::` line —
 * that escape exists for a block whose body legitimately holds *other* blocks, like `block-tabs`'s
 * template nesting `block-tab`s). A template that opens with its *own* block's fence is therefore
 * always a bug: the picker/toolbar wrap it a second time, producing a block nested one level inside
 * an identical outer block. The nested instance is invisible at read time (most blocks have no
 * `<slot>` reaching into their light DOM) while quietly stealing whatever the block reads out of its
 * own light DOM — `block-checklist`'s `[...this.querySelectorAll('li')]` item scan is the case that
 * surfaced this (OpenProject #1711).
 */

const blockDirNames = readdirSync(import.meta.dirname, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('block-'))
  .map((entry) => entry.name)
  .sort()

/**
 * Pulls the `static definition = { … }` object literal's source text out of a block's
 * `component.js` and evaluates just that, rather than importing the module. Importing every block
 * for real is what each block's own `component.test.js` has to work around case by case — pdfjs-dist
 * reads `DOMMatrix` at import time (jsdom doesn't implement it), `block-katex` touches
 * `document.adoptedStyleSheets` at module scope, and several others pull in heavy rendering
 * libraries (mermaid, KaTeX, Leaflet, swagger-ui) with no bearing on this check at all. The doc
 * comment above every `static definition` already promises "Values must be plain literals", so a
 * quote-aware, brace-matched slice — tracking whether we're inside a string so a literal `{`/`}`
 * within the template itself (MDC attribute syntax, e.g. `{runKey="…"}`) doesn't throw off the
 * count — evaluates safely with no imports and no side effects.
 *
 * Comments are skipped outright (not just left to fall through to the quote tracker): a `//` or
 * `/* *\/` comment can itself contain a stray apostrophe (a contraction like "this file's" is all
 * over these header comments) that would otherwise be read as opening a string, desyncing the
 * quote tracker from there through the rest of the scan and leaving the brace count never
 * reaching zero at the definition's real closing brace.
 */
function readDefinition(source) {
  const marker = 'static definition ='
  const markerIndex = source.indexOf(marker)
  if (markerIndex === -1) {
    return null
  }
  const braceStart = source.indexOf('{', markerIndex)
  let depth = 0
  let quote = null
  let end = -1
  for (let i = braceStart; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      if (char === '\\') {
        i++
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '/' && source[i + 1] === '/') {
      const lineEnd = source.indexOf('\n', i)
      i = lineEnd === -1 ? source.length : lineEnd
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const commentEnd = source.indexOf('*/', i + 2)
      i = commentEnd === -1 ? source.length : commentEnd + 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) {
    return null
  }
  const literal = source.slice(braceStart, end)
  return new Function(`return (${literal})`)()
}

describe('block definition templates', () => {
  for (const dirName of blockDirNames) {
    it(`${dirName}'s template does not nest its own block opener`, () => {
      const source = readFileSync(path.join(import.meta.dirname, dirName, 'component.js'), 'utf8')
      const definition = readDefinition(source)

      expect(definition, `${dirName}/component.js has no static definition object`).not.toBeNull()

      const template = definition.template ?? ''
      const selfOpener = new RegExp(`(^|\\n)\\s*:::?block-${definition.block}\\b`)

      expect(template).not.toMatch(selfOpener)
    })
  }
})

/**
 * An Iconify reference — `<prefix>:<name>`, e.g. `tabler:sitemap`. The same shape
 * `frontend/scripts/generate-icons.mjs` matches, minus its surrounding quotes.
 */
const ICONIFY_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-.][a-z0-9]+)*$/

/**
 * Every consumer of `definition.icon` — `AdminBlocks.vue`, `BlockPickerOverlay.vue` and
 * `BlockParamsDialog.vue` — hands the value straight to `WIcon`, which resolves an Iconify
 * reference and draws NOTHING for anything else (CLAUDE.md, under Icons: an unprefixed name "falls
 * through to `kind: 'none'` and draws nothing"). All 26 blocks shipped bare, unprefixed names —
 * `run-command`, `todo-list`, `visualy-impaired` (sic) — left behind by the Tabler migration, which
 * scans `frontend/src` only and so never saw them, and every one of those surfaces rendered an
 * empty slot (OpenProject #2634).
 *
 * The absence of this one assertion is what let that ship, so it is asserted structurally, off the
 * same source-text read the template check uses, rather than left to a reviewer's eye.
 */
describe('block definition icons', () => {
  for (const dirName of blockDirNames) {
    it(`${dirName} declares an Iconify icon reference`, () => {
      const source = readFileSync(path.join(import.meta.dirname, dirName, 'component.js'), 'utf8')
      const definition = readDefinition(source)

      expect(definition, `${dirName}/component.js has no static definition object`).not.toBeNull()
      expect(
        definition.icon,
        `${dirName}'s icon must be an Iconify reference like 'tabler:sitemap', not '${definition.icon}'`
      ).toMatch(ICONIFY_REF)
    })
  }
})
