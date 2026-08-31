/*
  Fails when a bare `err.message` reaches a `notify()` call anywhere under `frontend/src`.

  `helpers/apiError.js`'s `apiErrorMessage(err, fallback)` exists specifically because `ky` parses
  the server's `{ ok, error, statusCode, message }` body into `err.data` before throwing -- reading
  `err.message` instead surfaces ky's own generic "Request failed with status code N" in place of
  the server's actual explanation. This is the drift check that keeps a migrated file from quietly
  regaining the bare form (or a new file introducing it for the first time): a hit fails the step,
  same `--deny-warnings` treatment as the icon and emoji checks alongside it in quality.yml.

  Scoped to `notify()` call ARGUMENTS specifically, not any `err.message` found near one -- a naive
  proximity grep would also flag `console.warn` lines that happen to sit a few lines from a `notify()`
  call (App.vue has exactly this shape). Parsing each `notify(...)` call's own argument list is what
  lets those sit unflagged with no allowlist entry needed.

  Two genuinely non-HTTP shapes exist and need an explicit allowlist entry each:
    - `components/ApiKeyCopyDialog.vue` -- both its `notify()` + `err.message` sites are clipboard
      failures (`navigator.clipboard` rejecting), not HTTP errors; there is nothing in `err.data` to
      prefer for those.
  `console.warn(...)` isn't a `notify()` call at all, so App.vue's own template-string warnings need
  no allowlist entry -- see the scoping note above.

  Usage: node scripts/check-notify-err-message.mjs
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Files where every `notify()` + `err.message` site has already been reviewed and is not an HTTP
 * error. Allowlisted by whole file rather than by line number, which would go stale the moment the
 * file is edited above the flagged line -- both current sites in this file are clipboard failures,
 * so there is nothing else in it a future edit could legitimately want flagged either.
 */
const ALLOWLIST_FILES = new Set(['components/ApiKeyCopyDialog.vue'])

/** A bare, unmediated reference to the caught error's `.message` -- optional-chained or not. */
const BARE_ERR_MESSAGE = /\berr\??\.message\b/

function* vueFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* vueFiles(full)
    } else if (entry.name.endsWith('.vue')) {
      yield full
    }
  }
}

function lineAt(src, index) {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (src[i] === '\n') {
      line++
    }
  }
  return line
}

/**
 * Every `notify(...)` call's argument text, paren-balanced rather than brace-matched -- a call
 * commonly nests further calls in its arguments (`t('key', { count })`, `apiErrorMessage(err)`), so
 * naive matching on the first `)` or `}` would truncate the body early.
 */
export function findNotifyCalls(src) {
  const calls = []
  const re = /\bnotify\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    const bodyStart = re.lastIndex
    let depth = 1
    let i = bodyStart
    while (i < src.length && depth > 0) {
      if (src[i] === '(') {
        depth++
      } else if (src[i] === ')') {
        depth--
      }
      i++
    }
    calls.push({ start: m.index, body: src.slice(bodyStart, i - 1) })
    re.lastIndex = i
  }
  return calls
}

/** Every `notify()` call in `src` that reaches a bare `err.message`, as `{ line }` entries. */
export function findViolations(src) {
  const violations = []
  for (const call of findNotifyCalls(src)) {
    if (BARE_ERR_MESSAGE.test(call.body)) {
      violations.push({ line: lineAt(src, call.start) })
    }
  }
  return violations
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const srcDir = path.join(root, 'src')
  const hits = []
  for (const file of vueFiles(srcDir)) {
    const relative = path.relative(srcDir, file).split(path.sep).join('/')
    if (ALLOWLIST_FILES.has(relative)) {
      continue
    }
    const contents = fs.readFileSync(file, 'utf8')
    for (const violation of findViolations(contents)) {
      hits.push({ file: relative, line: violation.line })
    }
  }

  if (hits.length) {
    console.error(
      `\n${hits.length} notify() call(s) reach a bare err.message -- use apiErrorMessage(err) from '@/helpers/apiError' instead:`
    )
    for (const hit of hits) {
      console.error(`  src/${hit.file}:${hit.line}`)
    }
    process.exit(1)
  }

  console.log('OK  no bare err.message reaches a notify() call')
}

// Guarded so `findNotifyCalls`/`findViolations` can be imported (by the co-located test) without
// also walking the real tree and potentially calling `process.exit()` as a side effect of import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
