/**
 * The two hang ceilings on `package.json`'s test scripts (OpenProject #2927).
 *
 * CI run 34434314694 (PR #61) printed its last backend test result, then nothing for 27 minutes
 * until the job's 30-minute `timeout-minutes` killed it -- no failing test named, no stack, nothing
 * to bisect from. Two things about `node --test` make that the default outcome of any wedge: it has
 * no per-test timeout unless `--test-timeout` says so, and it waits for each test-file child process
 * to exit, so a file whose tests all passed but which left a handle alive (a worker thread a pool
 * teardown did not reap, say) holds the whole run open with nothing left to report. Both were
 * reproduced against fixtures on the pinned Node before the flags were added; the second is
 * re-proven live below, since it is the one Node's own docs are quietest about.
 *
 * Co-located with `package.json` the way `base.test.ts` sits beside `base.yml`: the scripts are
 * the subject, and there is nothing in `test/` they belong next to instead. The reasoning is
 * `docs/decisions/testing-strategy.md`'s "Bounded test time".
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const BACKEND_ROOT = import.meta.dirname
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..')

const PACKAGE = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

type WorkflowStep = { run?: string; 'working-directory'?: string }
type Workflow = { jobs: Record<string, { 'timeout-minutes'?: number; steps: WorkflowStep[] }> }
const QUALITY = load(
  fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/quality.yml'), 'utf8')
) as Workflow

/** Both lanes run under the same ceilings: a quarantined test can wedge as easily as any other. */
const RUNNER_SCRIPTS = ['test', 'test:flaky'] as const

/**
 * The slowest single suite on record, `userCredentials recovery codes (DB-backed)` at 112s in CI
 * run 34426049890 -- real bcrypt at `BCRYPT_ROUNDS`, under `--test-concurrency=4` on a 4-vCPU
 * runner. `--test-timeout` binds each suite over ALL its subtests (verified: it does not bind a
 * file's root), so the ceiling has to clear this with room for a slow runner, or the hang detector
 * becomes a new source of red trunk.
 */
const SLOWEST_SUITE_ON_RECORD_MS = 112_000
const SLOWEST_SUITE_MARGIN = 2

/**
 * What the gate job's backend tests step costs when nothing hangs: 11m22s for the whole job in
 * run 34426049890, rounded up. A ceiling only helps if a hang reported at the ceiling still leaves
 * the rest of the job inside `timeout-minutes` -- otherwise the job is killed exactly as before,
 * just with a named test somewhere in a log nobody gets to read.
 */
const JOB_BASELINE_MS = 12 * 60_000

function testTimeoutMs(script: string): number | undefined {
  const match = /--test-timeout=(\d+)(?:\s|$)/.exec(script)
  return match ? Number(match[1]) : undefined
}

/** The `quality.yml` job that runs `npm run test` from `backend/`, by its own steps. */
function gateJob() {
  const entry = Object.entries(QUALITY.jobs).find(([, job]) =>
    job.steps.some(
      (step) => step['working-directory'] === 'backend' && step.run?.trim() === 'npm run test'
    )
  )
  assert.ok(entry, 'quality.yml has a job running `npm run test` from backend/')
  return entry[1]
}

describe('package.json test scripts carry the two hang ceilings (OpenProject #2927)', () => {
  for (const name of RUNNER_SCRIPTS) {
    const script = PACKAGE.scripts[name]!

    test(`${name}: --test-force-exit, so a leaked handle cannot hold the run open`, () => {
      assert.match(script, /(^|\s)--test-force-exit(\s|$)/)
    })

    test(`${name}: --test-timeout clears the slowest suite on record with margin`, () => {
      const ceiling = testTimeoutMs(script)
      assert.ok(ceiling, `${name} must pass --test-timeout=<ms>`)
      assert.ok(
        ceiling >= SLOWEST_SUITE_ON_RECORD_MS * SLOWEST_SUITE_MARGIN,
        `--test-timeout=${ceiling} is under ${SLOWEST_SUITE_MARGIN}x the slowest suite on record (${SLOWEST_SUITE_ON_RECORD_MS}ms)`
      )
    })

    test(`${name}: a hang reported at the ceiling still finishes inside the gate job's timeout`, () => {
      const ceiling = testTimeoutMs(script)!
      const jobTimeoutMinutes = gateJob()['timeout-minutes']
      assert.ok(jobTimeoutMinutes, 'the gate job declares timeout-minutes')
      assert.ok(
        ceiling + JOB_BASELINE_MS < jobTimeoutMinutes * 60_000,
        `--test-timeout=${ceiling} plus the job's ${JOB_BASELINE_MS}ms baseline does not fit inside timeout-minutes: ${jobTimeoutMinutes}`
      )
    })
  }

  test('the default lane and the quarantine lane run under the same ceiling', () => {
    assert.equal(
      testTimeoutMs(PACKAGE.scripts.test!),
      testTimeoutMs(PACKAGE.scripts['test:flaky']!)
    )
  })

  /**
   * The live half: `--test-force-exit` really does end a child whose tests passed but whose event
   * loop a worker thread is keeping alive. Without the flag this same spawn never returns (it is
   * how the flag was chosen); `spawnSync`'s own `timeout` is the safety net, and a kill by it is
   * reported as the failure it would be.
   */
  test('--test-force-exit ends a test file that leaves a worker thread alive', () => {
    const fixture = path.join(BACKEND_ROOT, 'test/fixtures/leakedWorkerHandle.ts')
    // -> A nested `node --test` must not inherit the outer runner's child-context marker, or it
    //    reports in the outer run's wire format instead of running as a runner of its own.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-force-exit', '--test-reporter=tap', fixture],
      { cwd: BACKEND_ROOT, env, encoding: 'utf8', timeout: 20_000 }
    )
    assert.equal(result.signal, null, 'the fixture run was killed by the safety-net timeout')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^# pass 1$/m)
  })
})
