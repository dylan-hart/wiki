/*
  Flags `backend/locales/en.json` keys with no reader in `frontend/src`, crediting a dynamic
  template-literal `t(...)` call's static prefix/suffix as covering every key it could resolve to at
  runtime. An unreferenced key still ships translated in every locale file and is re-synced through
  Localazy on every release for nothing.

  Usage: node scripts/check-locales.mjs
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `path.join(..., '..')` rather than `new URL('../', import.meta.url)`: the latter goes through the
// ambient `URL`, which a DOM test environment (happy-dom) shadows with an implementation that does
// not resolve a relative `file:` URL the way Node's does.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const LOCALE_FILE = path.join(ROOT, '../backend/locales/en.json')

const ANY_LITERAL = /(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g

/*
 * The negative lookbehind on the bare form is what keeps this off `API_CLIENT.get(...)`/`.post(...)`
 * /`.put(...)`/`.delete(...)`: each ends in a bare `t(` too, and `\b` doesn't fire between two word
 * characters, so a plain `/\bt\(/` lets them straight through. The `i18n.t(` alternative covers the
 * rare `useI18n({ useScope: 'global' })` instance (`App.vue`).
 */
const T_CALL_LITERAL = new RegExp(
  `(?:(?<![\\w$.])t|(?<![\\w$])i18n\\.t)\\(\\s*${ANY_LITERAL.source}`,
  'g'
)

/*
 * A call whose key comes from a lookup table rather than a literal -- `t(SYNC_MODE_LABEL_KEYS[mode]
 * ?? mode)`, `t(RECENT_TAB.label)`. `IDENT` is resolved by `resolveTableLiterals`.
 */
const T_CALL_MEMBER = /(?:(?<![\w$.])t|(?<![\w$])i18n\.t)\(\s*([A-Za-z_$][\w$]*)\s*[.[]/g

/*
 * An `<i18n-t>` component's `keypath` attribute: a literal path unbound, a JS expression to pull
 * literals out of when bound. `[^"]*` spans newlines, which a wrapped multi-line binding needs.
 */
const KEYPATH_ATTR = /:?keypath="([^"]*)"/g

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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every `${...}` slot becomes `.*` -- unbounded rather than `[^.]*`, since a slot can fill anything
 * from a whole path segment to a value concatenated straight onto a literal suffix with no
 * separating dot, or even the entire prefix. Matching too broadly only risks under-reporting a dead
 * key; matching too narrowly would flag a key a dynamic call really does reach, which is the
 * direction that breaks the check.
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
 * `startIdx` must be the opening bracket. String and template-literal content is skipped so a value
 * holding a stray bracket can't desync the depth count; a `${...}` briefly resumes real
 * depth-counting for its own nested expression, then returns to string mode.
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
 * Resolves what `t(IDENT[...])`/`t(IDENT.prop)` can reach by finding `IDENT`'s own `const`
 * declaration in the same file and pulling every string literal out of its body. That works because
 * this codebase's convention is to spell an indirect key out as a literal in a lookup table rather
 * than assemble it at runtime, keeping it visible to translation tooling.
 *
 * Falls back to a `v-for="IDENT (in|of) OTHER"` loop variable when `IDENT` isn't itself declared.
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
 * Top-level means not nested inside `()`/`[]`/`{}` and not inside a string or template literal, so
 * a `+`/`,` within a nested call or a literal's own text doesn't split.
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
 * Handles a `t(...)` key built by string concatenation rather than a template literal. A `+`-joined
 * term that isn't a whole literal contributes `.*`, on `toMatcher`'s unbounded-slot reasoning; a
 * call with no top-level `+` is left to `T_CALL_LITERAL`/`T_CALL_MEMBER`.
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
      // A non-bound `keypath="..."` attribute's content IS the key, verbatim, though it isn't
      // quoted as a JS literal. Harmless for a bound expression: its text matches no real key.
      matchers.push({ kind: 'exact', value: content.trim() })
      for (const lit of content.matchAll(ANY_LITERAL)) {
        matchers.push(toMatcher(lit[1]))
      }
    }
    matchers.push(...collectConcatMatchers(src))
  }
  return matchers
}

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
