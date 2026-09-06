/**
 * The structural half of the logging conventions gate (OpenProject #2668, Phase 2 of Epic #2643;
 * spec: `docs/logging-reviews/2026-09-05-recommendations.md` §8.2).
 *
 * Three gates enforce the conventions between them, and they cover different things:
 *
 * - **The type checker** covers the scope vocabulary at a *scoped child*'s declaration
 *   (`WIKI.logger.scope('storage', …)` — `LogScope` is a union, so a typo is a compile error) and,
 *   once #2668 deleted the legacy `(msg, context?)` overload, the shape of every direct call too.
 * - **`no-console` in `backend/.oxlintrc.json`** covers the other direction: a line that never
 *   reached the logger at all.
 * - **This file** covers what neither can see — that a call site says the *right thing*: a scope
 *   from the vocabulary, a message an operator can read, and an error in `fields.error` rather than
 *   pasted over the message.
 *
 * Same shape as `api/routeTags.test.ts` / `api/responseErrors.test.ts`: a scan over the real source
 * tree, so a new call site is covered the moment it is written and there is no per-file list to keep
 * in step.
 *
 * **Escape hatch.** `// log-conventions: allow <reason>` on the line immediately above a call
 * exempts that one call. It exists because every rule below is a text heuristic over a language the
 * scanner does not parse — a genuinely correct line the heuristic refuses is annotated, never
 * answered by loosening the rule for everybody.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { LOG_SCOPES } from '../core/logScopes.ts'
import { listSourceFiles } from './sourceFiles.ts'

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What the scan is NOT about.
 *
 * `test/` and `*.test.ts` log deliberately odd things to prove the renderer handles them;
 * `scripts/` and `db/migrations/` are one-off/generated code that runs outside a booted `WIKI`
 * (`scripts/` carries a file-level `no-console` disable for the same reason).
 */
const SKIP_DIRS = ['node_modules', 'compiled', 'test', 'scripts', 'migrations']

/** Every level the logger implements, plus the two 2.x names that must never come back. */
const LEVELS = ['error', 'warn', 'info', 'debug'] as const
const RETIRED_LEVELS = ['verbose', 'silly'] as const

/**
 * Acronyms allowed to open a message in capitals.
 *
 * A message is a lowercase sentence fragment, but `HTTP server failed to bind` is not the same
 * sentence as `http server failed to bind` — `http` there would read as the scope name repeated.
 * Closed list on purpose: a sixth acronym is a deliberate edit here, not a call site's own decision.
 */
const ALLOWED_LEADING_ACRONYMS = ['HTTP', 'HTTPS', 'SQL', 'DB', 'API', 'MCP', 'TLS', 'URL']

/**
 * Message arguments that are an error and nothing else — the pre-Phase-2 call shape
 * (`WIKI.logger.error(err)`, and the `err.message` variant that at least kept the line readable).
 *
 * The audit's finding (§4.1) is that both throw away the situation: an operator gets
 * `ENOENT: no such file or directory` with nothing saying what the instance was trying to do. The
 * fix is always the same — a message that names the operation, and the error in `fields.error`,
 * where the renderer puts it and its stack on the SAME record.
 */
const ERROR_ONLY_MESSAGE = /^(err|error|e|ex)(\.message)?$/

const CODE = 0
const COMMENT = 1
const STRING = 2

/**
 * Characters after which a `/` opens a regular expression rather than dividing.
 *
 * Without this the scanner reads `/[\s"]/` in `core/logger.ts` as a division followed by an
 * unterminated string, and every logger call after it in that file disappears from the scan — a
 * silent hole, which is the one failure mode a gate must not have.
 */
const REGEX_PRECEDERS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'do',
  'else',
  'yield',
  'await'
])

/**
 * One byte per source character: is it code, a comment, or the inside of a string?
 *
 * Every rule below is a text match, and a text match over raw source finds the sample calls in doc
 * comments as readily as the real thing — `helpers/errorHandler.ts`'s own comment contains the
 * literal text `WIKI.logger.error(error)` while explaining why that shape was wrong, and would
 * otherwise fail the very rule it documents. Template literals re-enter code inside `${…}`, so an
 * interpolated call is still seen.
 */
function classifySource(src: string): Uint8Array {
  const mask = new Uint8Array(src.length)
  const modes: Array<'code' | 'template'> = ['code']
  const braceDepths: number[] = [0]
  let previousToken = ''
  let i = 0

  const fill = (from: number, to: number, kind: number) => {
    for (let j = from; j < Math.min(to, src.length); j++) {
      mask[j] = kind
    }
  }

  while (i < src.length) {
    if (modes[modes.length - 1] === 'template') {
      const c = src[i]
      if (c === '\\') {
        fill(i, i + 2, STRING)
        i += 2
        continue
      }
      if (c === '`') {
        mask[i] = STRING
        i += 1
        modes.pop()
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        fill(i, i + 2, STRING)
        i += 2
        modes.push('code')
        braceDepths.push(0)
        previousToken = '{'
        continue
      }
      mask[i] = STRING
      i += 1
      continue
    }

    const c = src[i]
    const next = src[i + 1]

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      fill(i, stop, COMMENT)
      i = stop
      continue
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      fill(i, stop, COMMENT)
      i = stop
      continue
    }
    if (c === '/' && REGEX_PRECEDERS.has(previousToken)) {
      mask[i] = STRING
      i += 1
      let inCharacterClass = false
      while (i < src.length) {
        const r = src[i]
        mask[i] = STRING
        if (r === '\\') {
          mask[i + 1] = STRING
          i += 2
          continue
        }
        i += 1
        if (r === '[') {
          inCharacterClass = true
        } else if (r === ']') {
          inCharacterClass = false
        } else if (r === '\n' || (r === '/' && !inCharacterClass)) {
          break
        }
      }
      previousToken = '/'
      continue
    }
    if (c === "'" || c === '"') {
      mask[i] = STRING
      let j = i + 1
      while (j < src.length) {
        mask[j] = STRING
        if (src[j] === '\\') {
          mask[j + 1] = STRING
          j += 2
          continue
        }
        if (src[j] === c || src[j] === '\n') {
          j += 1
          break
        }
        j += 1
      }
      previousToken = c
      i = j
      continue
    }
    if (c === '`') {
      mask[i] = STRING
      i += 1
      modes.push('template')
      continue
    }
    if (c === '{') {
      braceDepths[braceDepths.length - 1] += 1
    } else if (c === '}') {
      if (braceDepths[braceDepths.length - 1] === 0 && modes.length > 1) {
        mask[i] = STRING
        i += 1
        modes.pop()
        braceDepths.pop()
        continue
      }
      braceDepths[braceDepths.length - 1] -= 1
    }

    if (/\S/.test(c)) {
      // -> A keyword before a `/` decides regex-vs-division too (`return /x/.test(s)`), so the token
      //    remembered is the whole identifier, not just its last character.
      if (/[A-Za-z_$]/.test(c)) {
        let j = i
        while (j < src.length && /[\w$]/.test(src[j])) {
          j += 1
        }
        previousToken = src.slice(i, j)
        i = j
        continue
      }
      previousToken = c
    }
    i += 1
  }

  return mask
}

interface LoggerCall {
  file: string
  line: number
  receiver: string
  level: string
  args: string[]
  annotated: boolean
}

/** Which receivers this scan claims: the global logger, and anything named as a logger. */
function isLoggerReceiver(receiver: string): boolean {
  if (receiver === 'WIKI.logger') {
    return true
  }
  const last = receiver.split('.').pop() ?? ''
  return last === 'log' || last === 'logger' || /(?:Log|Logger)$/.test(last)
}

/**
 * The argument list of a call, split at top level.
 *
 * Depth counting consults the mask, so a `)` inside a message string or a `,` inside a doc comment
 * in the middle of a multi-line call does not end an argument early — and multi-line calls are the
 * common case here (`core/db.ts:103`, `tasks/migrate.ts:84`, every call with a fields object).
 */
function splitArguments(src: string, mask: Uint8Array, open: number): string[] | null {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < src.length; i++) {
    if (mask[i] !== CODE) {
      continue
    }
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') {
      depth += 1
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth === 0) {
        const tail = src.slice(start, i).trim()
        if (tail.length > 0 || args.length > 0) {
          args.push(tail)
        }
        return args
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i).trim())
      start = i + 1
    }
  }
  return null
}

/**
 * `<receiver>.<level>(` — the four real levels plus the two retired ones, so a `verbose` call is
 * *found* and then refused by name rather than quietly falling outside the scan.
 */
const CALL_PATTERN = new RegExp(
  String.raw`\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(${[...LEVELS, ...RETIRED_LEVELS].join('|')})\s*\(`,
  'g'
)

/** Every logger call in one file, with the annotation state of the line above each. */
function collectCalls(file: string, source?: string): LoggerCall[] {
  // -> `source` is for this file's own coverage of the scanner: the escape hatch and the
  //    receiver/argument rules are only trustworthy if they can be driven with a known input, and
  //    writing a temp file to do that would make the scan's own tests depend on the filesystem.
  const src = source ?? readFileSync(file, 'utf8')
  const mask = classifySource(src)
  const lineStarts: number[] = [0]
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') {
      lineStarts.push(i + 1)
    }
  }
  const lineOf = (offset: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (lineStarts[mid] <= offset) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    return lo
  }
  const lines = src.split('\n')

  const out: LoggerCall[] = []
  CALL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CALL_PATTERN.exec(src)) !== null) {
    if (mask[match.index] !== CODE) {
      continue
    }
    const [receiver, level] = [match[1], match[2]]
    if (!isLoggerReceiver(receiver)) {
      continue
    }
    const open = match.index + match[0].length - 1
    const args = splitArguments(src, mask, open)
    if (args === null) {
      continue
    }
    const lineIndex = lineOf(match.index)
    // -> The annotation sits on the line above, so a wrapped call ("the call starts here") and a
    //    one-liner are annotated the same way.
    let above = lineIndex - 1
    while (above >= 0 && lines[above].trim() === '') {
      above -= 1
    }
    out.push({
      file: path.relative(BACKEND_ROOT, file),
      line: lineIndex + 1,
      receiver,
      level,
      args,
      annotated: above >= 0 && /\/\/\s*log-conventions:\s*allow\s+\S/.test(lines[above])
    })
  }
  return out
}

/** `'boot'` -> `boot`; anything that is not a single-quoted or double-quoted literal -> `null`. */
function stringLiteralValue(text: string): string | null {
  const match = /^(['"])((?:[^\\]|\\.)*?)\1$/.exec(text)
  return match ? match[2] : null
}

/** The readable text of a message argument, or `null` when it is a variable this scan cannot read. */
function messageText(text: string): string | null {
  const literal = stringLiteralValue(text)
  if (literal !== null) {
    return literal
  }
  if (text.startsWith('`') && text.endsWith('`')) {
    return text.slice(1, -1)
  }
  return null
}

const ALL_CALLS = listSourceFiles(BACKEND_ROOT, {
  ext: ['.ts'],
  skip: ['.test.ts', '.d.ts'],
  skipDirs: SKIP_DIRS
  // -> An arrow, not a bare `collectCalls`: `flatMap` hands its callback the index as a second
  //    argument, which `collectCalls`' optional `source` parameter would swallow.
}).flatMap((file) => collectCalls(file))

/** The message argument, wherever it sits: second on a parent call, first on a scoped child's. */
function messageArgument(call: LoggerCall): string | undefined {
  return call.receiver === 'WIKI.logger' ? call.args[1] : call.args[0]
}

/**
 * The four rules, as named functions rather than lambdas inside their tests.
 *
 * Each answers `null` for a call it is happy with, or the sentence the failure message shows. Named
 * so the fixture test at the bottom can drive every one of them against a known-bad source — three
 * of the four pass vacuously on a clean tree, and a rule that has never fired is a rule nobody has
 * checked.
 */
function retiredLevelFailure(call: LoggerCall): string | null {
  return (RETIRED_LEVELS as readonly string[]).includes(call.level)
    ? `\`${call.level}\` is not a level this logger implements — use \`debug\``
    : null
}

function scopeFailure(call: LoggerCall): string | null {
  if (call.receiver !== 'WIKI.logger') {
    return null
  }
  if (call.args.length === 0) {
    return 'no arguments — a call is `(scope, message, fields?)`'
  }
  const scope = stringLiteralValue(call.args[0])
  if (scope === null) {
    return `first argument \`${call.args[0]}\` is not a string literal — the scope is spelled inline so this scan and the type checker can both see it`
  }
  if (!(LOG_SCOPES as readonly string[]).includes(scope)) {
    return `\`${scope}\` is not in LOG_SCOPES — add a field to an existing scope rather than a new scope`
  }
  if (call.args.length < 2) {
    return 'a scope with no message — the second argument is the sentence an operator reads'
  }
  return null
}

function errorAsMessageFailure(call: LoggerCall): string | null {
  // -> A one-argument parent call is the pre-scope shape entire: what looks like the scope slot is
  //    holding what used to be the whole message. `scopeFailure` refuses it too, but only as "not a
  //    string literal"; this says what to do about it.
  const message =
    messageArgument(call) ?? (call.receiver === 'WIKI.logger' ? call.args[0] : undefined)
  if (message === undefined) {
    return null
  }
  return ERROR_ONLY_MESSAGE.test(message)
    ? `\`${message}\` as the message — say what failed, and pass the error as \`{ error: ${message.split('.')[0]} }\``
    : null
}

function messageShapeFailure(call: LoggerCall): string | null {
  const argument = messageArgument(call)
  if (argument === undefined) {
    return null
  }
  const text = messageText(argument)
  if (text === null) {
    // -> A variable message (`WIKI.logger.info('migrate', note)`) is assembled elsewhere; the rules
    //    still apply, this scan just cannot read it.
    return null
  }
  if (/\[ [A-Z]+ \]/.test(text)) {
    return 'contains an `[ OK ]`-style tag — the level and scope columns already say this'
  }
  if (text.endsWith('.')) {
    return text.endsWith('...')
      ? 'ends in `...` — a structured line is complete on its own, there is no continuation'
      : 'ends in a period — a message is a fragment, not a sentence'
  }
  if (/^[A-Z]/.test(text)) {
    const leadingWord = /^[A-Za-z]+/.exec(text)?.[0] ?? ''
    if (!ALLOWED_LEADING_ACRONYMS.includes(leadingWord)) {
      return `starts with a capital (\`${leadingWord}\`) — messages are lowercase unless they open with a known acronym (${ALLOWED_LEADING_ACRONYMS.join(', ')})`
    }
  }
  return null
}

/** `file:line  WIKI.logger.info(…)` — enough to jump straight to the offender. */
function describeCall(call: LoggerCall): string {
  return `${call.file}:${call.line}  ${call.receiver}.${call.level}(${call.args.join(', ').slice(0, 90)})`
}

function failures(predicate: (call: LoggerCall) => string | null): string[] {
  const out: string[] = []
  for (const call of ALL_CALLS) {
    if (call.annotated) {
      continue
    }
    const reason = predicate(call)
    if (reason !== null) {
      out.push(`${describeCall(call)}\n    -> ${reason}`)
    }
  }
  return out
}

function assertNoFailures(found: string[], remedy: string): void {
  assert.equal(
    found.length,
    0,
    `${found.length} logging call site(s) break the convention:\n\n${found.join('\n\n')}\n\n${remedy}`
  )
}

/**
 * OpenProject #2723: the four rules above only ever look at `WIKI.logger`/scoped-child receivers
 * (`isLoggerReceiver`) -- a bare status word passed straight to `console.<level>()` is invisible to
 * all of them, which is exactly how `core/config.ts`'s pre-logger boot window
 * (`console.info(styleText(['green', 'bold'], 'OK'))`) survived every gate this file polices. A
 * `console.*` call before `WIKI.logger` exists is a documented sink exception (CLAUDE.md's Logging
 * section, `core/config.ts` named explicitly) -- that exception covers *where* the line goes, not
 * the 2.x-style tag, which the conventions ban regardless of sink.
 *
 * Deliberately narrower than `messageShapeFailure`'s full battery: a `console.*` call is often
 * genuine human-facing CLI text (a script's `Usage: ...` line, an interactive tool's status prose)
 * that has no reason to read as a lowercase log fragment, so only the closed set of 2.x-style status
 * words is refused here, not the whole shape. The check runs on the raw argument text rather than
 * requiring the tag to be the direct argument, since the real shape wraps it in a styling call
 * (`styleText([...], 'OK')`).
 */
const STATUS_TAG_WORDS = ['OK', 'FAILED', 'SKIPPED', 'COMPLETED'] as const
const STATUS_TAG_LITERAL = new RegExp(String.raw`(['"])(${STATUS_TAG_WORDS.join('|')})\1`)
const CONSOLE_CALL_PATTERN = /\bconsole\.(log|info|warn|error|debug)\s*\(/g

interface ConsoleCall {
  file: string
  line: number
  args: string[]
}

/** Every `console.<level>(...)` call in one file -- not filtered by `isLoggerReceiver`. */
function collectConsoleCalls(file: string, source?: string): ConsoleCall[] {
  const src = source ?? readFileSync(file, 'utf8')
  const mask = classifySource(src)
  const lineStarts: number[] = [0]
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') {
      lineStarts.push(i + 1)
    }
  }
  const lineOf = (offset: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (lineStarts[mid] <= offset) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    return lo
  }

  const out: ConsoleCall[] = []
  CONSOLE_CALL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CONSOLE_CALL_PATTERN.exec(src)) !== null) {
    if (mask[match.index] !== CODE) {
      continue
    }
    const open = match.index + match[0].length - 1
    const args = splitArguments(src, mask, open)
    if (args === null) {
      continue
    }
    out.push({ file: path.relative(BACKEND_ROOT, file), line: lineOf(match.index) + 1, args })
  }
  return out
}

const ALL_CONSOLE_CALLS = listSourceFiles(BACKEND_ROOT, {
  ext: ['.ts'],
  skip: ['.test.ts', '.d.ts'],
  skipDirs: SKIP_DIRS
}).flatMap((file) => collectConsoleCalls(file))

describe('logging conventions (OpenProject #2668)', () => {
  test('the scan actually found the logger call sites it is meant to police', () => {
    // -> A scanner that silently matches nothing passes every rule below. `backend/` had 339 direct
    //    `WIKI.logger.*` calls when this was written, so a floor of 200 catches a regex or a mask
    //    bug without turning the count itself into something to keep updated.
    assert.ok(
      ALL_CALLS.length >= 200,
      `expected the scan to find the backend's logger call sites; found only ${ALL_CALLS.length} — the scanner is broken, not the codebase`
    )
    assert.ok(
      ALL_CALLS.some((call) => call.file === 'index.ts'),
      'expected the boot lines in index.ts to be in the scan'
    )
  })

  test('`verbose` and `silly` are gone and stay gone', () => {
    // -> #2647 deleted both levels: 2.x had six, this logger has four, and a `verbose` call is a
    //    method that does not exist rather than a line nobody reads.
    assertNoFailures(
      failures(retiredLevelFailure),
      'Levels are `error` / `warn` / `info` / `debug` (docs/logging-reviews/2026-09-05-recommendations.md §3).'
    )
  })

  test('every `WIKI.logger.<level>` call names a scope from LOG_SCOPES', () => {
    // -> A scoped child gets this from the type checker (`LogScope` is a union at `.scope()`), but a
    //    direct call's first argument is only checked here when the value is spelled inline — and
    //    the vocabulary being CLOSED is the whole point: a new subsystem is a field on an existing
    //    scope, not a 28th name (§2.3).
    assertNoFailures(
      failures(scopeFailure),
      'The vocabulary is `backend/core/logScopes.ts`; extending it is a deliberate edit there, not a call site decision.'
    )
  })

  test('no call passes an error where the message belongs', () => {
    // -> §4.1: `WIKI.logger.error(err)` renders `ENOENT: no such file or directory` and nothing about
    //    what the instance was doing. The message names the operation; the error goes in
    //    `fields.error`, which is what puts the situation and the stack on one record.
    assertNoFailures(
      failures(errorAsMessageFailure),
      'Pattern: `WIKI.logger.error(scope, "fetching locale metadata failed", { error: err })`.'
    )
  })

  test('messages are lowercase sentence fragments with no tag and no trailing period', () => {
    // -> §4.2/§4.3: `[ OK ]`-style tags and `MODULE/SUBMODULE` prefixes were the 2.x way of saying
    //    what a line was about; the scope field says it now, and a tag is one more thing to strip
    //    before a line is greppable. A trailing period reads as prose in a column of fragments, and
    //    `...` promised a follow-up line that a structured logger does not emit.
    assertNoFailures(
      failures(messageShapeFailure),
      'Annotate a genuine exception with `// log-conventions: allow <reason>` rather than widening the rule.'
    )
  })

  test('the escape hatch is used sparingly and always carries a reason', () => {
    // -> An annotation with no reason is a silenced rule nobody can review. The cap is not a budget
    //    to spend: it is there so a wave of annotations shows up as a failing test rather than as a
    //    quiet erosion of the gate.
    const annotated = ALL_CALLS.filter((call) => call.annotated)
    assert.ok(
      annotated.length <= 12,
      `${annotated.length} calls carry \`// log-conventions: allow\`; if the rules are wrong, fix the rules:\n${annotated.map(describeCall).join('\n')}`
    )
  })

  test('the escape hatch exempts the call below it, and only that one', () => {
    // -> #2672/#2674/#2676 were told to annotate rather than ask for a rule to be widened, so the
    //    annotation has to actually work — including the "and only that one" half, or one exemption
    //    would quietly cover a whole file.
    const source = [
      "WIKI.logger.info('boot', 'Capitalised And Ends.')",
      '// log-conventions: allow a fixture proving the annotation is read',
      "WIKI.logger.info('boot', 'Capitalised And Ends.')",
      '',
      "WIKI.logger.info('boot', 'Capitalised And Ends.')"
    ].join('\n')
    const calls = collectCalls('fixture.ts', source)

    assert.deepEqual(
      calls.map((call) => call.annotated),
      [false, true, false],
      'only the call on the line after the annotation is exempt'
    )
    // -> A bare `// log-conventions: allow` with no reason after it is not an annotation at all.
    assert.equal(
      collectCalls('fixture.ts', "// log-conventions: allow\nWIKI.logger.info('boot', 'x')")[0]!
        .annotated,
      false
    )
  })

  test('the scanner ignores calls that only appear in comments and strings', () => {
    // -> Self-check for `classifySource`, the one part of this file whose failure mode is silence:
    //    a mask bug either invents failures out of doc comments (`helpers/errorHandler.ts` quotes
    //    the very shape the rules refuse) or hides real calls after a regex literal.
    const src = [
      '// WIKI.logger.error(err)',
      'const sample = \'WIKI.logger.info("nope")\'',
      'const re = /[\\s"]/',
      "WIKI.logger.info('boot', 'real call')",
      '/** WIKI.logger.warn(error) */',
      'WIKI.logger.debug(`sql`, `also real`)'
    ].join('\n')
    const mask = classifySource(src)
    const seen: string[] = []
    CALL_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = CALL_PATTERN.exec(src)) !== null) {
      if (mask[match.index] === CODE) {
        seen.push(`${match[1]}.${match[2]}`)
      }
    }
    assert.deepEqual(seen, ['WIKI.logger.info', 'WIKI.logger.debug'])
  })

  test('the rules actually reject the shapes they name', () => {
    // -> The rules above are only as good as their predicates, and every one of them passes
    //    vacuously on a clean tree. These are the shapes the audit found, run through the same
    //    helpers the scan uses.
    assert.equal(stringLiteralValue("'boot'"), 'boot')
    assert.equal(stringLiteralValue('scopeVariable'), null)
    assert.equal(
      messageText('`phase ${result.phase} ${result.status}`'),
      'phase ${result.phase} ${result.status}'
    )
    assert.equal(messageText('note'), null)
    assert.ok(ERROR_ONLY_MESSAGE.test('err'))
    assert.ok(ERROR_ONLY_MESSAGE.test('err.message'))
    assert.ok(ERROR_ONLY_MESSAGE.test('error'))
    assert.ok(!ERROR_ONLY_MESSAGE.test('errorCount'))
    assert.ok(!ERROR_ONLY_MESSAGE.test("'sending mail failed'"))
  })

  test('each rule fires on the shape it names, through the real scanner', () => {
    // -> Three of the four rules pass vacuously on a clean tree, so without this they prove nothing
    //    about a call site written tomorrow. Every line below is a shape the audit actually found in
    //    `backend/`, driven through `collectCalls` rather than through a hand-built `LoggerCall`.
    const failing = (source: string, rule: (call: LoggerCall) => string | null) =>
      collectCalls('fixture.ts', source).filter((call) => rule(call) !== null).length

    assert.equal(failing("WIKI.logger.verbose('db', 'connected')", retiredLevelFailure), 1)
    assert.equal(failing("WIKI.logger.debug('db', 'connected')", retiredLevelFailure), 0)

    assert.equal(failing("WIKI.logger.info('comments', 'posted')", scopeFailure), 1)
    assert.equal(failing('WIKI.logger.info(scope, `posted`)', scopeFailure), 1)
    assert.equal(failing("WIKI.logger.info('db')", scopeFailure), 1)
    assert.equal(failing("WIKI.logger.info('db', 'connected')", scopeFailure), 0)

    assert.equal(failing('WIKI.logger.error(err)', errorAsMessageFailure), 1)
    assert.equal(failing("WIKI.logger.error('db', err.message)", errorAsMessageFailure), 1)
    assert.equal(failing('log.error(error)', errorAsMessageFailure), 1)
    assert.equal(
      failing(
        "WIKI.logger.error('db', 'connecting failed', { error: err })",
        errorAsMessageFailure
      ),
      0
    )

    assert.equal(failing("WIKI.logger.info('db', 'connected [ OK ]')", messageShapeFailure), 1)
    assert.equal(failing("WIKI.logger.info('db', 'connecting...')", messageShapeFailure), 1)
    assert.equal(failing("WIKI.logger.info('db', 'Connected to postgres')", messageShapeFailure), 1)
    assert.equal(
      failing("WIKI.logger.info('db', 'connected successfully.')", messageShapeFailure),
      1
    )
    // -> The allow-list, and the interpolated first token, both of which real call sites use.
    assert.equal(
      failing("WIKI.logger.warn('http', 'HTTP server failed to bind')", messageShapeFailure),
      0
    )
    assert.equal(
      failing('WIKI.logger.info(`migrate`, `${phase} finished`)', messageShapeFailure),
      0
    )
    // -> A scoped child's message is its FIRST argument, so the rule has to read the right one.
    assert.equal(failing("log.info('Pulling From Origin.')", messageShapeFailure), 1)
    assert.equal(failing("log.info('pulling from origin')", messageShapeFailure), 0)
  })

  test('no raw console.<level> call anywhere in backend/ carries a 2.x-style status tag (OpenProject #2723)', () => {
    const found = ALL_CONSOLE_CALLS.filter((call) =>
      call.args.some((arg) => STATUS_TAG_LITERAL.test(arg))
    )
    assert.deepEqual(
      found.map((call) => `${call.file}:${call.line}`),
      [],
      'A console call before WIKI.logger exists is a documented sink exception (CLAUDE.md), not an exemption from the tag-free convention -- write the fact into the message instead of a bare OK/FAILED/SKIPPED/COMPLETED.'
    )
  })

  test('the console-call scan actually catches the shape it is meant to police', () => {
    // -> The exact shape `core/config.ts` used to carry: the tag is a nested argument to a styling
    //    call, not the direct argument, which is why this checks the raw argument text rather than
    //    requiring the message itself to be the bare literal.
    const calls = collectConsoleCalls(
      'fixture.ts',
      "console.info(styleText(['green', 'bold'], 'OK'))"
    )
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.args.some((arg) => STATUS_TAG_LITERAL.test(arg)))
    assert.equal(collectConsoleCalls('fixture.ts', "console.log('pulling from origin')").length, 1)
    assert.ok(
      !STATUS_TAG_LITERAL.test(
        collectConsoleCalls('fixture.ts', "console.log('pulling from origin')")[0]!.args[0]!
      )
    )
  })
})
