/**
 * A passing test that leaves a live worker thread behind -- the class of hang `--test-timeout`
 * cannot see, because no test is still running. Under plain `node --test` this never exits; under
 * `--test-force-exit` it exits once the test reports, which is what `package.test.ts` asserts.
 * Deliberately not a `*.test.ts`, so the default glob never runs it as a suite.
 */
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'

new Worker('setInterval(() => {}, 1000)', { eval: true })

test('passes, and leaves a worker thread alive behind it', () => {})
