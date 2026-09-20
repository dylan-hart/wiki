/*
  Fails when a bare `err.message` reaches a `notify()` call anywhere under `frontend/src`.

  `helpers/apiError.js`'s `apiErrorMessage(err, fallback)` exists specifically because `ky` parses
  the server's `{ ok, error, statusCode, message }` body into `err.data` before throwing -- reading
  `err.message` instead surfaces ky's own generic "Request failed with status code N" in place of
  the server's actual explanation.

  Scoped to `notify()` call ARGUMENTS specifically, not any `err.message` found near one: a naive
  proximity grep would also flag a `console.warn` line sitting a few lines from a `notify()` call,
  a shape this codebase really has. Parsing each call's own argument list is what lets those sit
  unflagged with no allowlist entry.

  Usage: node scripts/check-notify-err-message.mjs
*/
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Files whose `notify()` + `err.message` sites are reviewed non-HTTP failures -- clipboard
 * rejections, with nothing in `err.data` to prefer over `err.message`. Allowlisted by whole file
 * rather than by line number, which would go stale on the first edit above the flagged line.
 */
const ALLOWLIST_FILES = new Set(['components/ApiKeyCopyDialog.vue'])

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
 * Paren-balanced rather than matched on the first `)` or `}`: a call commonly nests further calls
 * in its arguments (`t('key', { count })`, `apiErrorMessage(err)`), which naive matching truncates.
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

// Guarded so the co-located test can import `findNotifyCalls`/`findViolations` without walking the
// real tree or hitting `process.exit()` as a side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
