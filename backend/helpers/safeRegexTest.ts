import vm from 'node:vm'

/**
 * RFC 5321's forward-path limit puts a real mailbox address at 254 characters, so this never
 * truncates a genuine one. Catastrophic backtracking is exponential in input length, so the cap is
 * what keeps a pathological pattern inside the timeout below rather than merely making a hit less
 * likely.
 */
export const REGEX_TEST_MAX_INPUT_LENGTH = 254

/**
 * Wall-clock ceiling for one guarded `.test()` call. Far above any legitimate match against a
 * capped input, far below the seconds-to-indefinite hang an unguarded catastrophic-backtracking
 * pattern produces.
 */
const REGEX_TEST_TIMEOUT_MS = 50

/**
 * `new RegExp(pattern).test(input)` under two independent bounds, so an admin-configurable pattern
 * can never hang the event loop however it was written: `input` is capped to
 * `REGEX_TEST_MAX_INPUT_LENGTH`, then the test runs inside a throwaway `node:vm` context with a
 * `timeout`. `helpers/timeout.ts#withTimeout` cannot stand in -- racing a promise against a timer
 * does nothing for a synchronous call that never yields -- while `vm`'s `timeout` interrupts a
 * running script mid-backtrack, at the interrupt points V8's own bytecode already contains.
 *
 * Pattern and input reach the sandbox as values on its global object, never concatenated into the
 * script source, so pattern text cannot escape the `new RegExp(...)` call it is written into.
 *
 * @returns `false` rather than throwing when the pattern does not match, fails to compile, or is
 *   cut off by the timeout, so a caller treating "unclear" as "refuse" needs no catch of its own.
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
    // -> A compile failure and a timeout are one outcome: the pattern does not get to allow anyone.
    return false
  }
}
