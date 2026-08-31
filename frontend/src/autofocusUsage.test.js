import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * OpenProject #1676: a structural regression guard for the dead-`autofocus`-attribute defect the
 * 2026-08-24 audit found (`docs/audit-2026-08-24/maintainability.md` §3 / `ux-flows.md` §9).
 *
 * `WInput.vue`'s root element used to be a non-focusable wrapping `<div>`, so a bare `autofocus`
 * attribute on a `<w-input>` tag landed there and did nothing -- 25 call sites across 20 files had
 * exactly that dead markup. Three of them (`ApprovalRuleDialog.vue`, `GlossaryTermDialog.vue`,
 * `SuggestionGuestDialog.vue`) already focused their field correctly through
 * `useDialogComponent({ autofocus: () => iptX.value })` (`composables/dialog.js`), which made their
 * template attribute redundant rather than broken -- but redundant dead markup is exactly the kind of
 * thing that silently reappears once nobody remembers why it was removed, which is what this guards.
 *
 * Ground truth as of this WP (see its OpenProject comment thread for the full account): the epic's
 * two children that were supposed to fix the 17 genuinely-broken call sites (#1668, #1671) wired every
 * one of them through `useDialogComponent`'s per-call-site `autofocus` option, deleting the dead
 * attribute at each. A sibling WP (#1649) separately -- and, per its own closing comment, without the
 * decision child #1664 ever formally arbitrating -- gave `WInput.vue` a real, working `autofocus` prop
 * (it focuses the control in its own `onMounted`). That prop is now used exactly once in the whole
 * tree, on `AuthLoginPanel.vue`'s TFA recovery-code field, which isn't behind `useDialogComponent` and
 * so has no dialog re-mount timing problem for `onMounted` to trip over -- a legitimate, working use,
 * not dead markup, and this test must not flag it.
 *
 * So the shape of the remaining defect this test can actually guard against, without re-litigating
 * #1664's still-open decision, is the concrete pattern the three named files had: a `<w-input>` (or
 * `<w-select>`, which grew the same prop) tag carrying a literal `autofocus` attribute in a file that
 * *also* calls `useDialogComponent({ autofocus: ... })` -- i.e. two focus mechanisms wired for the
 * same dialog, one of them necessarily inert or redundant. Should a future change settle #1664 in
 * favor of the component prop everywhere, this guard's premise changes and it should be revisited
 * then, not guessed at now.
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
    const files = walk(SRC_ROOT)
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
