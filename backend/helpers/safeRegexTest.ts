import vm from 'node:vm'

/**
 * Longest string ever worth testing an admin-configured `allowedEmailRegex` against
 * (`models/authentication.ts`, `models/login.ts`). RFC 5321's forward-path limit puts a real
 * mailbox address at 254 characters at the very most, so this never truncates a genuine address --
 * it only bounds how much of an attacker-supplied string a pathological pattern ever gets to chew
 * on, which matters because catastrophic backtracking is exponential in input length: capping the
 * length is what keeps even a pattern that slips past `isSafePattern` (or was saved before that
 * check existed) inside the timeout below rather than merely making it less likely to hit it.
 */
export const REGEX_TEST_MAX_INPUT_LENGTH = 254

/**
 * Wall-clock ceiling for one guarded `.test()` call, in milliseconds. Generous relative to any
 * legitimate pattern (a real match against a &lt;=254-char string is sub-millisecond) but small
 * enough that even a pathological one can only ever cost a login attempt this much, not the
 * seconds-to-indefinite hang an unguarded catastrophic-backtracking pattern produces.
 */
const REGEX_TEST_TIMEOUT_MS = 50

/**
 * Runs `new RegExp(pattern).test(input)` with two independent bounds, so an admin-configurable
 * pattern (`allowedEmailRegex`) can never hang the event loop no matter how it was written --
 * whether it is one `models/authentication.ts#validateStrategy`'s `isSafePattern` check already
 * refused at save time, or a pathological one saved before that check existed (OpenProject #3372).
 *
 * `input` is capped to `REGEX_TEST_MAX_INPUT_LENGTH` characters first (see its own doc comment),
 * then the test itself runs inside a throwaway `node:vm` context with a `timeout`. Unlike
 * `helpers/timeout.ts#withTimeout` -- whose own doc comment is explicit that it "can[not] cancel...
 * a worker thread", because racing a promise against a timer does nothing for a *synchronous* call
 * that never yields the event loop -- `vm`'s `timeout` genuinely interrupts a running script,
 * including mid-backtrack inside `RegExp.prototype.test`, because V8 checks for it at the interrupt
 * points its own bytecode already contains. That is what makes an in-process, per-call bound
 * possible here at all, with no worker-thread pool needed for what is a hot, per-login-attempt path.
 *
 * The pattern and input are passed into the sandbox as plain values on its global object, never
 * concatenated into the script source, so pattern text cannot escape the `new RegExp(...)` call it
 * is written into.
 *
 * @returns `false` -- never a thrown error -- when the pattern does not match, when it fails to
 *   compile, and when the timeout wins, so a caller that already treats "unclear" as "refuse" (an
 *   invalid pattern "allows nobody, rather than everybody") does not need its own catch around this.
 */
export function testRegexSafely(pattern: string, input: string): boolean {
  const boundedInput =
    input.length > REGEX_TEST_MAX_INPUT_LENGTH ? input.slice(0, REGEX_TEST_MAX_INPUT_LENGTH) : input
  const sandbox: { pattern: string; input: string; result?: boolean } = {
    pattern,
    input: boundedInput
  }
  try {
    vm.createContext(sandbox)
    vm.runInContext('result = new RegExp(pattern).test(input)', sandbox, {
      timeout: REGEX_TEST_TIMEOUT_MS
    })
    return sandbox.result === true
  } catch {
    // -> Either the pattern failed to compile, or the timeout fired ("Script execution timed
    //    out..."). Both are the same outcome to a caller: this pattern cannot be trusted to answer,
    //    so it does not get to allow anyone through.
    return false
  }
}
