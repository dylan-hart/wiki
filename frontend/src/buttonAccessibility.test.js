import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * WP #1598: a structural regression guard for the census the audit ran by hand
 * (`docs/audit-2026-08-24/accessibility-i18n.md` §4) -- every `<w-btn>` (and `<w-btn-toggle>`, which
 * renders its own focusable segments and needs the same `aria-label`) must carry an accessible name,
 * either a `label`/`aria-label`/`title` attribute or real text in its own body. Runs the same shape of
 * check the audit's one-off census did, but as a real `npm run test` assertion, so a new icon-only
 * button added later fails CI instead of silently joining the next audit's findings.
 *
 * Deliberately re-implemented here rather than imported from a build script: unlike
 * `scripts/generate-icons.mjs` (which produces a committed artifact `npm run icons` regenerates),
 * this check has no output to commit -- it only ever needs to run as an assertion, so a script
 * entry point would just be an extra file this test re-invokes for no benefit.
 */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.name.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Parses one tag starting at `text[start]` (`text[start] === '<'`), respecting quoted attribute
 * values so an embedded `>` (e.g. inside a JS expression like `:disabled="a > b"`) doesn't end the
 * tag early. Returns the tag name, its raw `<...>` slice (for attribute checks), the index just past
 * the tag, and whether it self-closes.
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
      const selfClosing = text[j - 1] === '/'
      return { tagName, attrs: text.slice(start, j + 1), endIndex: j + 1, selfClosing }
    }
    j += 1
  }
  return { tagName, attrs: text.slice(start), endIndex: text.length, selfClosing: false }
}

/** Finds the matching `</tagName>` for the open tag ending at `afterOpenIdx`, honouring nesting. */
function findMatchingClose(text, tagName, afterOpenIdx) {
  const openRe = new RegExp(`<${tagName}\\b`, 'g')
  const closeRe = new RegExp(`</${tagName}\\s*>`)
  let depth = 1
  let idx = afterOpenIdx
  while (idx < text.length) {
    openRe.lastIndex = idx
    const openMatch = openRe.exec(text)
    const closeMatch = closeRe.exec(text.slice(idx))
    const closeStart = closeMatch ? idx + closeMatch.index : -1
    if (closeStart === -1) {
      return { inner: text.slice(afterOpenIdx, idx), endIndex: idx }
    }
    if (openMatch && openMatch.index < closeStart) {
      const { endIndex, selfClosing } = parseTag(text, openMatch.index)
      if (!selfClosing) depth += 1
      idx = endIndex
      continue
    }
    depth -= 1
    if (depth === 0) {
      return {
        inner: text.slice(afterOpenIdx, closeStart),
        endIndex: closeStart + closeMatch[0].length
      }
    }
    idx = closeStart + closeMatch[0].length
  }
  return { inner: text.slice(afterOpenIdx, idx), endIndex: idx }
}

/** Strips `<w-menu>...</w-menu>` blocks -- a menu's own contents are not the trigger's visible label. */
function stripWMenu(inner) {
  let result = inner
  for (;;) {
    const m = /<w-menu\b/.exec(result)
    if (!m) return result
    const { endIndex, selfClosing } = parseTag(result, m.index)
    if (selfClosing) {
      result = result.slice(0, m.index) + result.slice(endIndex)
      continue
    }
    const { endIndex: closeEnd } = findMatchingClose(result, 'w-menu', endIndex)
    result = result.slice(0, m.index) + result.slice(closeEnd)
  }
}

function hasNameAttr(attrs) {
  return /(^|\s):?(label|aria-label|title)\s*=/.test(attrs)
}

function visibleText(inner) {
  const noComments = inner.replace(/<!--[\s\S]*?-->/g, '')
  return noComments
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Finds every `<w-btn>`/`<w-btn-toggle>` in one file's template with no accessible name: no
 * `label`/`aria-label`/`title` attribute, and no visible text in its own body once any nested
 * `<w-menu>` panel is stripped out. `<w-btn-group>` is a layout wrapper, not a button itself, so it
 * is excluded even though the tag prefix matches.
 */
function findUnnamedButtons(filePath) {
  const fullText = fs.readFileSync(filePath, 'utf8')
  // -> Scoped to the `<template>` block alone, found with the same tag-balance parser used for
  //    `<w-btn>` below (so nested slot templates like `<template #hint>...</template>` don't end it
  //    early) rather than a regex up to the last `</template>` in the file: a `<script setup>` doc
  //    comment illustrating usage (e.g. `<template #action><w-btn ... /></template>` inside a JSDoc
  //    block, as `components/shared/WCardHeader.vue` has) is not live markup and must not be
  //    censused, and a greedy `[\s\S]*<\/template>` regex has no way to stop before reaching it.
  const templateOpenIdx = fullText.indexOf('<template')
  if (templateOpenIdx === -1) return []
  const { endIndex: templateContentStart } = parseTag(fullText, templateOpenIdx)
  const { inner: text } = findMatchingClose(fullText, 'template', templateContentStart)
  const lineOffset = fullText.slice(0, templateContentStart).split('\n').length - 1
  const tagRe = /<(w-btn(?:-[a-zA-Z]+)?)\b/g
  const findings = []
  let match
  while ((match = tagRe.exec(text))) {
    const { tagName, attrs, endIndex, selfClosing } = parseTag(text, match.index)
    if (tagName === 'w-btn-group') continue
    const named = hasNameAttr(attrs)
    let innerText = ''
    if (!selfClosing) {
      const { inner } = findMatchingClose(text, tagName, endIndex)
      innerText = visibleText(stripWMenu(inner))
    }
    if (!named && !innerText) {
      const line = lineOffset + text.slice(0, match.index).split('\n').length
      findings.push({ file: path.relative(SRC_ROOT, filePath), line, tagName })
    }
  }
  return findings
}

describe('every w-btn has an accessible name', () => {
  it('finds no <w-btn>/<w-btn-toggle> with no label, aria-label, title or visible text', () => {
    const files = walk(SRC_ROOT)
    const findings = files.flatMap((f) => findUnnamedButtons(f))

    expect(findings, JSON.stringify(findings, null, 2)).toEqual([])
  })
})
