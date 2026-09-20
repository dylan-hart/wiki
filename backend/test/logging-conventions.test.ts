/**
 * The structural half of the logging conventions gate. The type checker covers the scope vocabulary
 * and the call shape; `no-console` covers a line that never reached the logger at all; this file
 * covers what neither can see — whether a call site says the *right thing*: a scope from the
 * vocabulary, a message an operator can read, and an error in `fields.error` rather than pasted over
 * the message. It scans the real source tree, so a new call site is covered the moment it is written
 * and there is no per-file list to keep in step.
 *
 * **Escape hatch.** `// log-conventions: allow <reason>` on the line immediately above a call
 * exempts that one call. Every rule below is a text heuristic over a language the scanner does not
 * parse, so a correct line the heuristic refuses is annotated rather than answered by loosening the
 * rule for everybody.
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
 * `test/` and `*.test.ts` log deliberately odd things to prove the renderer handles them;
 * `scripts/` and `db/migrations/` run outside a booted `CARDINAL` entirely.
 */
const SKIP_DIRS = ['node_modules', 'compiled', 'test', 'scripts', 'migrations']

const LEVELS = ['error', 'warn', 'info', 'debug'] as const
const RETIRED_LEVELS = ['verbose', 'silly'] as const

/**
 * A message is a lowercase fragment, but `HTTP server failed to bind` is not the same sentence as
 * `http server failed to bind` — `http` there reads as the scope name repeated. Closed on purpose:
 * another acronym is a deliberate edit here, not a call site's own decision.
 */
const ALLOWED_LEADING_ACRONYMS = ['HTTP', 'HTTPS', 'SQL', 'DB', 'API', 'MCP', 'TLS', 'URL']

/**
 * A message argument that is an error and nothing else throws away the situation: an operator gets
 * `ENOENT: no such file or directory` with nothing saying what the instance was trying to do. The
 * fix is always a message naming the operation plus the error in `fields.error`, which is what puts
 * both on the same record.
 */
const ERROR_ONLY_MESSAGE = /^(err|error|e|ex)(\.message)?$/

const CODE = 0
const COMMENT = 1
const STRING = 2

/**
 * Tokens after which a `/` opens a regular expression rather than dividing. Without this the scanner
 * reads a regex like `/[\s"]/` as a division followed by an unterminated string, and every logger
 * call after it in that file disappears from the scan — the one failure mode a gate must not have.
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
 * One byte per source character: code, comment, or the inside of a string. Every rule below is a
 * text match, and over raw source a text match finds the sample calls quoted in doc comments as
 * readily as the real thing — so a comment explaining why a shape is wrong would fail the very rule
 * it documents. Template literals re-enter code inside `${…}`, so an interpolated call is still seen.
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

function isLoggerReceiver(receiver: string): boolean {
  if (receiver === 'CARDINAL.logger') {
    return true
  }
  const last = receiver.split('.').pop() ?? ''
  return last === 'log' || last === 'logger' || /(?:Log|Logger)$/.test(last)
}

/**
 * Depth counting consults the mask, so a `)` inside a message string or a `,` inside a comment
 * mid-call does not end an argument early — and multi-line calls are the common case here.
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
 * Matches the retired levels too, so a `verbose` call is *found* and then refused by name rather
 * than quietly falling outside the scan.
 */
const CALL_PATTERN = new RegExp(
  String.raw`\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(${[...LEVELS, ...RETIRED_LEVELS].join('|')})\s*\(`,
  'g'
)

function collectCalls(file: string, source?: string): LoggerCall[] {
  // -> `source` lets this file's own tests drive the scanner with a known input, without a temp
  //    file making them depend on the filesystem.
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
    // -> The annotation sits above the line the call STARTS on, so a wrapped call and a one-liner
    //    are annotated the same way.
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

function stringLiteralValue(text: string): string | null {
  const match = /^(['"])((?:[^\\]|\\.)*?)\1$/.exec(text)
  return match ? match[2] : null
}

/** `null` when the argument is a variable this scan cannot read. */
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

function messageArgument(call: LoggerCall): string | undefined {
  return call.receiver === 'CARDINAL.logger' ? call.args[1] : call.args[0]
}

/** Each rule answers `null` for a call it is happy with, or the sentence the failure shows. */
function retiredLevelFailure(call: LoggerCall): string | null {
  return (RETIRED_LEVELS as readonly string[]).includes(call.level)
    ? `\`${call.level}\` is not a level this logger implements — use \`debug\``
    : null
}

function scopeFailure(call: LoggerCall): string | null {
  if (call.receiver !== 'CARDINAL.logger') {
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
  // -> On a one-argument parent call the scope slot is holding the message. `scopeFailure` refuses
  //    it too, but only as "not a string literal"; this says what to do about it.
  const message =
    messageArgument(call) ?? (call.receiver === 'CARDINAL.logger' ? call.args[0] : undefined)
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
    // -> A variable message is assembled elsewhere: the rules still apply, this scan cannot read it.
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
 * The rules above only look at logger receivers, so a status word passed straight to
 * `console.<level>()` in the pre-logger boot window is invisible to every one of them. Being a
 * documented `console.*` sink exception covers *where* a line goes, not the 2.x-style tag, which is
 * banned regardless of sink.
 *
 * Deliberately narrower than `messageShapeFailure`: `console.*` is often genuine human-facing CLI
 * text with no reason to read as a lowercase log fragment, so only these words are refused. The
 * check runs on the raw argument text because the real shape wraps the tag in a styling call.
 */
const STATUS_TAG_WORDS = ['OK', 'FAILED', 'SKIPPED', 'COMPLETED'] as const
const STATUS_TAG_LITERAL = new RegExp(String.raw`(['"])(${STATUS_TAG_WORDS.join('|')})\1`)
const CONSOLE_CALL_PATTERN = /\bconsole\.(log|info|warn|error|debug)\s*\(/g

interface ConsoleCall {
  file: string
  line: number
  args: string[]
}

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
    // -> A scanner that silently matches nothing passes every rule below. The floor is loose on
    //    purpose: it catches a regex or mask bug without becoming a count to keep updated.
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
    assertNoFailures(
      failures(retiredLevelFailure),
      'Levels are `error` / `warn` / `info` / `debug` (docs/logging-reviews/2026-09-05-recommendations.md §3).'
    )
  })

  test('every `CARDINAL.logger.<level>` call names a scope from LOG_SCOPES', () => {
    // -> A scoped child gets this from the type checker (`LogScope` is a union at `.scope()`); a
    //    direct call's first argument is only checked here, and only when spelled inline.
    assertNoFailures(
      failures(scopeFailure),
      'The vocabulary is `backend/core/logScopes.ts`; extending it is a deliberate edit there, not a call site decision.'
    )
  })

  test('no call passes an error where the message belongs', () => {
    assertNoFailures(
      failures(errorAsMessageFailure),
      'Pattern: `CARDINAL.logger.error(scope, "fetching locale metadata failed", { error: err })`.'
    )
  })

  test('messages are lowercase sentence fragments with no tag and no trailing period', () => {
    // -> The scope field says what a `[ OK ]`-style tag used to, and a tag is one more thing to
    //    strip before a line is greppable. `...` promises a follow-up line nothing ever emits.
    assertNoFailures(
      failures(messageShapeFailure),
      'Annotate a genuine exception with `// log-conventions: allow <reason>` rather than widening the rule.'
    )
  })

  test('the escape hatch is used sparingly and always carries a reason', () => {
    // -> The cap is not a budget to spend: it is there so a wave of annotations shows up as a
    //    failing test rather than as a quiet erosion of the gate.
    const annotated = ALL_CALLS.filter((call) => call.annotated)
    assert.ok(
      annotated.length <= 12,
      `${annotated.length} calls carry \`// log-conventions: allow\`; if the rules are wrong, fix the rules:\n${annotated.map(describeCall).join('\n')}`
    )
  })

  test('the escape hatch exempts the call below it, and only that one', () => {
    // -> The "and only that one" half matters as much as the exemption itself: without it, one
    //    annotation would quietly cover a whole file.
    const source = [
      "CARDINAL.logger.info('boot', 'Capitalised And Ends.')",
      '// log-conventions: allow a fixture proving the annotation is read',
      "CARDINAL.logger.info('boot', 'Capitalised And Ends.')",
      '',
      "CARDINAL.logger.info('boot', 'Capitalised And Ends.')"
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
    // -> `classifySource` is the part of this file whose failure mode is silence: a mask bug either
    //    invents failures out of doc comments or hides real calls after a regex literal.
    const src = [
      '// CARDINAL.logger.error(err)',
      'const sample = \'CARDINAL.logger.info("nope")\'',
      'const re = /[\\s"]/',
      "CARDINAL.logger.info('boot', 'real call')",
      '/** CARDINAL.logger.warn(error) */',
      'CARDINAL.logger.debug(`sql`, `also real`)'
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
    assert.deepEqual(seen, ['CARDINAL.logger.info', 'CARDINAL.logger.debug'])
  })

  test('the rules actually reject the shapes they name', () => {
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
    //    about a call site written tomorrow. Driven through the real `collectCalls`, not a
    //    hand-built `LoggerCall`, so the scanner is on trial here too.
    const failing = (source: string, rule: (call: LoggerCall) => string | null) =>
      collectCalls('fixture.ts', source).filter((call) => rule(call) !== null).length

    assert.equal(failing("CARDINAL.logger.verbose('db', 'connected')", retiredLevelFailure), 1)
    assert.equal(failing("CARDINAL.logger.debug('db', 'connected')", retiredLevelFailure), 0)

    assert.equal(failing("CARDINAL.logger.info('comments', 'posted')", scopeFailure), 1)
    assert.equal(failing('CARDINAL.logger.info(scope, `posted`)', scopeFailure), 1)
    assert.equal(failing("CARDINAL.logger.info('db')", scopeFailure), 1)
    assert.equal(failing("CARDINAL.logger.info('db', 'connected')", scopeFailure), 0)

    assert.equal(failing('CARDINAL.logger.error(err)', errorAsMessageFailure), 1)
    assert.equal(failing("CARDINAL.logger.error('db', err.message)", errorAsMessageFailure), 1)
    assert.equal(failing('log.error(error)', errorAsMessageFailure), 1)
    assert.equal(
      failing(
        "CARDINAL.logger.error('db', 'connecting failed', { error: err })",
        errorAsMessageFailure
      ),
      0
    )

    assert.equal(failing("CARDINAL.logger.info('db', 'connected [ OK ]')", messageShapeFailure), 1)
    assert.equal(failing("CARDINAL.logger.info('db', 'connecting...')", messageShapeFailure), 1)
    assert.equal(
      failing("CARDINAL.logger.info('db', 'Connected to postgres')", messageShapeFailure),
      1
    )
    assert.equal(
      failing("CARDINAL.logger.info('db', 'connected successfully.')", messageShapeFailure),
      1
    )
    assert.equal(
      failing("CARDINAL.logger.warn('http', 'HTTP server failed to bind')", messageShapeFailure),
      0
    )
    assert.equal(
      failing('CARDINAL.logger.info(`migrate`, `${phase} finished`)', messageShapeFailure),
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
      'A console call before CARDINAL.logger exists is a documented sink exception, not an exemption from the tag-free convention -- write the fact into the message instead of a bare OK/FAILED/SKIPPED/COMPLETED.'
    )
  })

  test('the console-call scan actually catches the shape it is meant to police', () => {
    // -> The tag arrives as a nested argument to a styling call, not the direct argument, which is
    //    why the check reads raw argument text rather than requiring a bare literal.
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
