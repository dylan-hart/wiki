/**
 * Fixture for `package.test.ts` (OpenProject #2927): a test file whose one test passes and which
 * then leaves a live worker thread behind -- the shape of handle a thread-pool teardown race can
 * leak, and the one class of hang `--test-timeout` cannot see, because no test is still running.
 *
 * Run under plain `node --test`, this file never exits: the runner waits for the child process,
 * the child waits for its event loop, and the worker's interval keeps the loop alive. Under
 * `--test-force-exit` it exits as soon as the test has reported, which is what `package.test.ts`
 * asserts. Not a `*.test.ts` on purpose, so the default glob never runs it as a suite.
 */
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'

new Worker('setInterval(() => {}, 1000)', { eval: true })

test('passes, and leaves a worker thread alive behind it', () => {})
