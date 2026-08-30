/*
  Flags `backend/locales/en.json` keys with no reader in `frontend/src`, crediting a dynamic
  template-literal `t(...)` call's static prefix/suffix as covering every key it could resolve to at
  runtime. Modeled on `generate-icons.mjs`'s `--check`: the same "source scan must stay in step with
  a side file" problem, just with no generated artifact to diff -- the side file here is
  `backend/locales/en.json` itself, and staying in step means every key in it has a reader.

  An unreferenced key still ships translated across 56 locale files and gets re-synced through
  Localazy on every release for nothing, which is the cost this check exists to catch early.

  Usage: node scripts/check-locales.mjs
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `path.join(..., '..')` rather than `new URL('../', import.meta.url)`: the latter goes through the
// ambient global `URL` constructor, which a DOM test environment (this repo's Vitest suites default
// to `happy-dom`) can shadow with its own browser-oriented implementation that doesn't resolve a
// relative `file:` URL the way Node's does. `fileURLToPath` and `path` are both plain Node core
// functions, unaffected either way.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const LOCALE_FILE = path.join(ROOT, '../backend/locales/en.json')

/** Any quoted or template-literal string, used both as the top-level scanner and inside a resolved
 *  lookup table's own source text (see `resolveTableLiterals`). */
const ANY_LITERAL = /(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g

/*
 * Matches a call to the i18n `t(...)` function -- `useI18n()`'s composable result, destructured as
 * `t` almost everywhere in this codebase (see CLAUDE.md's Frontend patterns), or called as `i18n.t(`
 * off the rare `useI18n({ useScope: 'global' })` instance itself (`App.vue`) -- whose first argument
 * is a string or template literal. The negative lookbehind on the bare form is what keeps it from
 * also matching `API_CLIENT.get(...)`/`.post(...)`/`.put(...)`/`.delete(...)`: every one of those
 * ends in a bare `t(` too, and a plain `/\bt\(/` would not tell them apart -- `\b` doesn't fire
 * between two word characters, so it lets `get(` and `put(` straight through.
 */
const T_CALL_LITERAL = new RegExp(
  `(?:(?<![\\w$.])t|(?<![\\w$])i18n\\.t)\\(\\s*${ANY_LITERAL.source}`,
  'g'
)

/*
 * Matches `t(IDENT[...` or `t(IDENT.prop)` (or the `i18n.t(` form) -- a call whose key comes from a
 * lookup table rather than a literal, e.g. `t(SYNC_MODE_LABEL_KEYS[mode] ?? mode)` or
 * `t(RECENT_TAB.label)`. `IDENT` is resolved separately (see `resolveTableLiterals`).
 */
const T_CALL_MEMBER = /(?:(?<![\w$.])t|(?<![\w$])i18n\.t)\(\s*([A-Za-z_$][\w$]*)\s*[.[]/g

/*
 * Matches an `<i18n-t>` component's `keypath` attribute, bound or not: `keypath="pageDeleteDialog.
 * confirm"` (a literal path, used as-is) or `:keypath="isCopyright ? \`common.footerCopyright\` :
 * \`common.footerLicense\`"` (a JS expression, which may itself contain one or more literals to
 * pull out). `[^"]*` spans newlines fine (character-class negation isn't affected by multiline
 * content), which is what a wrapped multi-line binding like `SiteActivateDialog.vue`'s needs.
 */
const KEYPATH_ATTR = /:?keypath="([^"]*)"/g

/** Start of a `t(...)`/`i18n.t(...)` call, used to locate the `(` for balanced-argument extraction
 *  ahead of splitting on top-level `+` (see `collectConcatMatchers`). */
const T_CALL_START = /(?:(?<![\w$.])t|(?<![\w$])i18n\.t)\(/g

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* sourceFiles(full)
    } else if (/\.(vue|js)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
      yield full
    }
  }
}

/** Escape one literal chunk of a template literal for use inside a RegExp. */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Turn one literal `t(...)` argument into a matcher: an exact key for a plain string (or a backtick
 * literal with no interpolation), or a RegExp standing in for the whole family of keys a template
 * literal could resolve to at runtime.
 *
 * Every `${...}` slot becomes `.*` -- unbounded rather than `[^.]*`, since a slot can fill anything
 * from a whole path segment (`` `error.${val}` ``) to a value concatenated straight onto a literal
 * suffix with no separating dot (`` `admin.api.${status}Hint` ``), or even the entire prefix
 * (`` `${labelPrefix}.revokeConfirm` ``). Matching too broadly only risks under-reporting a
 * genuinely dead key that happens to share a literal fragment with a live dynamic lookup -- never
 * flagging a key that a dynamic call really does reach, which is the direction that would actually
 * break the check.
 */
function toMatcher(rawLiteral) {
  const quote = rawLiteral[0]
  const body = rawLiteral.slice(1, -1)
  if (quote !== '`' || !body.includes('${')) {
    return { kind: 'exact', value: body }
  }
  const pattern = body
    .split(/\$\{[^}]*\}/)
    .map(escapeRegExp)
    .join('.*')
  return { kind: 'regex', value: new RegExp(`^${pattern}$`) }
}

/**
 * Extract the balanced `{...}`/`[...]`/`(...)` span starting at `startIdx` (which must be the
 * opening bracket), skipping over string/template-literal content so a value containing a stray
 * bracket character can't desync the depth count. A `${...}` inside a template literal briefly
 * resumes real depth-counting for its own nested expression, then returns to string mode.
 */
function extractBalanced(src, startIdx) {
  const closers = { '{': '}', '[': ']', '(': ')' }
  const open = src[startIdx]
  const close = closers[open]
  if (!close) {
    return null
  }
  let depth = 0
  let inString = null
  let templateDepth = 0
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (ch === '\\') {
        i++
        continue
      }
      if (inString === '`' && ch === '$' && src[i + 1] === '{') {
        inString = null
        templateDepth = 1
        i++
        continue
      }
      if (ch === inString) {
        inString = null
      }
      continue
    }
    if (templateDepth > 0) {
      if (ch === '{') {
        templateDepth++
      } else if (ch === '}') {
        templateDepth--
        if (templateDepth === 0) {
          inString = '`'
        }
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) {
        return src.slice(startIdx, i + 1)
      }
    }
  }
  return null
}

/**
 * Resolve every literal `t(IDENT[...])`/`t(IDENT.prop)` reaches back to, by finding `IDENT`'s own
 * `const IDENT = {...}`/`const IDENT = [...]` declaration in the same file and pulling every string
 * literal out of its (balanced, string-aware) body -- covers a mode-to-key lookup table
 * (`SYNC_MODE_LABEL_KEYS`), a tab definition object (`GROUP_TABS`/`RECENT_TAB`), or an options array
 * (`STYLE_CLASSES`). See `TableEditorOverlay.vue`'s own header comment by `ALIGN_LABELS`: spelling
 * the key out as a literal in a lookup table, rather than assembling it at runtime, is this
 * codebase's established way to keep an indirect key visible to translation tooling -- the same
 * convention `generate-icons.mjs` documents for icon names.
 *
 * Falls back to a `v-for="IDENT (in|of) OTHER"` loop variable when `IDENT` isn't itself declared --
 * `t(option.label)` inside `v-for="option of STYLE_CLASSES"` resolves through to `STYLE_CLASSES`.
 */
function resolveTableLiterals(src, name, visited = new Set()) {
  if (visited.has(name)) {
    return []
  }
  visited.add(name)

  const declMatch = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*=\\s*`).exec(src)
  if (declMatch) {
    const valueStart = declMatch.index + declMatch[0].length
    const body = extractBalanced(src, valueStart)
    if (body) {
      return [...body.matchAll(ANY_LITERAL)].map((m) => m[1])
    }
  }

  const forMatch = new RegExp(
    `v-for="\\s*${escapeRegExp(name)}\\s+(?:in|of)\\s+([A-Za-z_$][\\w$]*)`
  ).exec(src)
  if (forMatch) {
    return resolveTableLiterals(src, forMatch[1], visited)
  }

  return []
}

/**
 * Split `str` on every top-level occurrence of `delimiter` -- one not nested inside `()`/`[]`/`{}`
 * or a string/template literal (so a `+`/`,` inside a nested call, or inside a literal's own text,
 * doesn't count). Used both to pull just the key argument out of a `t(key, params)` call and to
 * break that argument into its `+`-joined terms.
 */
function splitTopLevel(str, delimiter) {
  const parts = []
  let depth = 0
  let inString = null
  let current = ''
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inString) {
      current += ch
      if (ch === '\\') {
        current += str[++i] ?? ''
        continue
      }
      if (ch === inString) {
        inString = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      current += ch
      continue
    }
    if ('([{'.includes(ch)) {
      depth++
    } else if (')]}'.includes(ch)) {
      depth--
    }
    if (ch === delimiter && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/**
 * Handles `t(...)` calls built by string concatenation rather than a template literal --
 * `` t(`admin.scheduler.` + state.displayMode + `None`) ``, `` t('editor.props.' + props.mode) ``.
 * Each `+`-joined term is either a whole literal (contributing its own text, verbatim) or anything
 * else (a variable, a call, a parenthesized fallback -- contributing `.*`, same unbounded-slot
 * reasoning as `toMatcher`'s template-literal handling). A call with no top-level `+` in its key
 * argument is left to `T_CALL_LITERAL`/`T_CALL_MEMBER` instead.
 */
function collectConcatMatchers(src) {
  const matchers = []
  for (const m of src.matchAll(T_CALL_START)) {
    const openIdx = m.index + m[0].length - 1
    const full = extractBalanced(src, openIdx)
    if (!full) {
      continue
    }
    const [keyArg] = splitTopLevel(full.slice(1, -1), ',')
    if (!keyArg.includes('+')) {
      continue
    }
    const terms = splitTopLevel(keyArg, '+').map((t) => t.trim())
    if (terms.length < 2) {
      continue
    }
    let pattern = ''
    for (const term of terms) {
      const lit = /^(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")$/.exec(term)
      pattern += lit
        ? lit[1]
            .slice(1, -1)
            .split(/\$\{[^}]*\}/)
            .map(escapeRegExp)
            .join('.*')
        : '.*'
    }
    matchers.push({ kind: 'regex', value: new RegExp(`^${pattern}$`) })
  }
  return matchers
}

export function collectMatchers(srcDir = SRC) {
  const matchers = []
  for (const file of sourceFiles(srcDir)) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(T_CALL_LITERAL)) {
      matchers.push(toMatcher(m[1]))
    }
    const tableNames = new Set([...src.matchAll(T_CALL_MEMBER)].map((m) => m[1]))
    for (const name of tableNames) {
      for (const literal of resolveTableLiterals(src, name)) {
        matchers.push(toMatcher(literal))
      }
    }
    for (const m of src.matchAll(KEYPATH_ATTR)) {
      const content = m[1]
      // A non-bound `keypath="..."` attribute's content IS the key, verbatim -- credit it directly
      // even though it isn't quoted as a JS literal. Harmless when this is actually a bound JS
      // expression instead: the whole expression text just won't equal any real key.
      matchers.push({ kind: 'exact', value: content.trim() })
      for (const lit of content.matchAll(ANY_LITERAL)) {
        matchers.push(toMatcher(lit[1]))
      }
    }
    matchers.push(...collectConcatMatchers(src))
  }
  return matchers
}

/** Every key with neither an exact-match reader nor a dynamic matcher that could resolve to it. */
export function findUnreferenced(keys, matchers) {
  const exact = new Set()
  const regexes = []
  for (const m of matchers) {
    if (m.kind === 'exact') {
      exact.add(m.value)
    } else {
      regexes.push(m.value)
    }
  }
  return keys.filter((key) => !exact.has(key) && !regexes.some((r) => r.test(key)))
}

function main() {
  const keys = Object.keys(JSON.parse(fs.readFileSync(LOCALE_FILE, 'utf8')))
  const unreferenced = findUnreferenced(keys, collectMatchers())

  if (unreferenced.length) {
    console.error(
      `\n${unreferenced.length} locale key(s) in backend/locales/en.json have no reader:`
    )
    for (const key of unreferenced) {
      console.error(`  ${key}`)
    }
    console.error(
      '\nRemove the dead key(s) from every backend/locales/*.json file, or reference them.'
    )
    process.exit(1)
  }

  console.log(`OK  ${keys.length} keys, all referenced`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
