/**
 * The anti-drift guard for `scripts/verify-ci.sh` (OpenProject #2686, under Feature #2601).
 *
 * `verify-ci` claims to run "exactly what CI runs". That claim is the entire value of the command,
 * and it is the kind of claim that rots silently: someone adds a step to `.github/workflows/
 * quality.yml`, nothing anywhere fails, and from that day on a green `verify-ci` means less than it
 * says. So the claim is checked mechanically here -- the workflow is parsed, its gate commands are
 * extracted, and every one of them must appear in the script at the same working directory.
 *
 * Deliberately NOT asserted here: anything about `.github/workflows/*.yml`'s `node-version:` values
 * matching the image's pin. That cross-check is sibling Task #2685's and belongs in
 * `devcontainerCiParity.test.ts`, beside the rest of the image-parity assertions.
 *
 * Neither `scripts/` nor `.github/` has a test workspace of its own to sit next to, so this lives
 * here as a structural/self-consistency check against repo-root files -- the same category
 * `devcontainerCiParity.test.ts`, `postgres-version-consistency.test.ts` and
 * `devcontainerDatabaseUrl.test.ts` already establish for this directory (see CLAUDE.md's
 * "Testing (backend)" for the rule).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const read = (relPath: string) => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')

const SCRIPT_PATH = 'scripts/verify-ci.sh'
const SCRIPT = read(SCRIPT_PATH)

type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  'working-directory'?: string
  'continue-on-error'?: boolean
}

type Workflow = { jobs: Record<string, { steps: WorkflowStep[] }> }

const QUALITY: Workflow = load(read('.github/workflows/quality.yml')) as Workflow
const BUILD: Workflow = load(read('.github/workflows/build.yml')) as Workflow

/** `<working directory>|<command>`, the shape both sides are normalised into before comparing. */
type Command = string

/**
 * Every shell command a job runs AS A GATE, one per line, keyed by the directory it runs in. A
 * `run:` block may be multi-line (`build.yml`'s "Build Assets" is `npm ci` then `npm run build`),
 * and a step with no `working-directory:` runs at the repo root, which the script spells `.`.
 *
 * Continuation lines (a trailing `\`) and shell-script bodies are folded away rather than split:
 * `quality.yml`'s git-cliff install and its boot smoke test are multi-line programs, not lists of
 * commands, and are matched below by their first line alone.
 *
 * A `continue-on-error: true` step is skipped, because it is not a gate: it cannot turn the CI run
 * red, so a green `verify-ci` that did not run it still predicts a green CI run, which is the whole
 * claim this file guards. The quarantine lane (OpenProject #2692) is the only such step today, and
 * `verify-ci` does run it -- report-only on both sides, asserted in its own describe below rather
 * than through this list, since a report-only step has no place in a gate-parity comparison.
 */
function commandsOf(job: { steps: WorkflowStep[] }): Command[] {
  const out: Command[] = []
  for (const step of job.steps) {
    if (typeof step.run !== 'string') continue
    if (step['continue-on-error'] === true) continue
    const dir = step['working-directory'] ?? '.'
    const folded = step.run.replace(/\\\n\s*/g, ' ')
    for (const raw of folded.split('\n')) {
      const line = raw.trim()
      if (line.length > 0) out.push(`${dir}|${line}`)
    }
  }
  return out
}

/**
 * Every `run_step '<label>' <dir> <command...>` invocation in the script, normalised the same way.
 *
 * The script's header says these must stay one per line and literal, for exactly this reason: a
 * command assembled from a variable would be invisible here while still running, which is the
 * failure mode this file exists to prevent rather than to acquire.
 */
function scriptSteps(): { label: string; command: Command }[] {
  const out: { label: string; command: Command }[] = []
  for (const raw of SCRIPT.split('\n')) {
    const match = /^\s*run_step '([^']+)' (\S+) (.+)$/.exec(raw)
    if (match) out.push({ label: match[1], command: `${match[2]}|${match[3]}` })
  }
  return out
}

const SCRIPT_STEPS = scriptSteps()
const SCRIPT_COMMANDS = new Set(SCRIPT_STEPS.map((s) => s.command))

/**
 * The commands `quality.yml` runs to PROVISION the runner rather than to gate the code. The parity
 * image installs all three at the same pinned version (see `.devcontainer/Dockerfile`), so the
 * script asserts their presence as a precondition instead of re-running them -- which is checked in
 * its own test below, so that this allowlist cannot quietly become a way to ignore a step.
 *
 * A NEW provisioning step added to the workflow matches nothing here and fails the first test,
 * which is the intent: somebody then has to decide whether it belongs in the image, in `--install`,
 * or in the gate.
 */
const PROVISIONED_BY_THE_IMAGE: { matches: RegExp; precondition: RegExp }[] = [
  { matches: /git-cliff/, precondition: /command -v git-cliff/ },
  { matches: /apt-get .*\bpandoc\b/, precondition: /command -v pandoc/ },
  { matches: /playwright install/, precondition: /PLAYWRIGHT_BROWSERS_PATH/ }
]

describe('scripts/verify-ci.sh mirrors the CI quality gate', () => {
  test('every command quality.yml’s gate job runs is run by the script too', () => {
    const missing: string[] = []

    for (const command of commandsOf(QUALITY.jobs.quality)) {
      if (SCRIPT_COMMANDS.has(command)) continue
      if (PROVISIONED_BY_THE_IMAGE.some(({ matches }) => matches.test(command))) continue
      missing.push(command)
    }

    assert.deepEqual(
      missing,
      [],
      'quality.yml runs these and scripts/verify-ci.sh does not, so a green verify-ci no longer ' +
        'means a green CI run. Add a run_step for each (or, if the parity image provides it, add ' +
        'it to PROVISIONED_BY_THE_IMAGE above with the precondition that proves it is there).'
    )
  })

  test('each provisioning step the script skips is instead asserted as a precondition', () => {
    for (const { matches, precondition } of PROVISIONED_BY_THE_IMAGE) {
      assert.ok(
        precondition.test(SCRIPT),
        `nothing in ${SCRIPT_PATH} checks for the tool matched by ${matches} before running the ` +
          'gate, so its absence would show up as a silently skipped test rather than a refusal'
      )
    }
  })

  test('the gate runs in quality.yml’s own order', () => {
    const gateCommands = commandsOf(QUALITY.jobs.quality).filter(
      (command) => SCRIPT_COMMANDS.has(command) && !command.endsWith('|npm ci') // installs are --install-gated
    )
    const scriptOrder = SCRIPT_STEPS.map((s) => s.command).filter((c) => gateCommands.includes(c))

    assert.deepEqual(
      scriptOrder,
      gateCommands,
      'the script runs the gate in a different order than CI does. Order matters here because both ' +
        'stop at the first failure: a reordered gate reports a different failure than CI would.'
    )
  })

  test('the documented step list in --help matches the steps actually run', () => {
    const help = SCRIPT.slice(SCRIPT.indexOf('WHAT IT RUNS BY DEFAULT'), SCRIPT.indexOf('OPTIONS'))

    for (const command of commandsOf(QUALITY.jobs.quality)) {
      if (!SCRIPT_COMMANDS.has(command) || command.endsWith('|npm ci')) continue
      const [dir, cmd] = command.split('|')
      const documented = dir === '.' ? `<root>    ${cmd}` : `${dir}    ${cmd}`
      assert.ok(
        help.includes(cmd),
        `--help does not list "${documented}", so the command's own documentation understates what ` +
          'it runs'
      )
    }
  })
})

describe('scripts/verify-ci.sh covers the legs outside the quality gate', () => {
  test('--e2e runs build.yml’s Playwright leg, not an invention of its own', () => {
    const buildCommands = new Set(commandsOf(BUILD.jobs.build))

    for (const command of ['frontend|npm run build', 'blocks|npm run build', 'e2e|npm test']) {
      assert.ok(
        buildCommands.has(command),
        `build.yml's build job no longer runs "${command}", so the script's --e2e leg has drifted ` +
          'from the workflow it mirrors'
      )
      assert.ok(SCRIPT_COMMANDS.has(command), `the script's --e2e leg does not run "${command}"`)
    }
  })

  test('--e2e is opt-in, because the e2e suite is not part of the quality gate', () => {
    const qualityCommands = new Set(commandsOf(QUALITY.jobs.quality))
    assert.ok(
      !qualityCommands.has('e2e|npm test'),
      'quality.yml now runs the e2e suite, so --e2e being opt-in makes verify-ci weaker than the ' +
        'gate it mirrors -- move it into the default path'
    )
    assert.match(SCRIPT, /RUN_E2E=0/)
  })

  test('--smoke-boot reproduces quality.yml’s production-install boot job', () => {
    const smokeJob = QUALITY.jobs['production-boot-smoke-test']
    assert.ok(smokeJob, 'quality.yml no longer has a production-boot-smoke-test job')

    const smokeText = commandsOf(smokeJob).join('\n')
    assert.match(smokeText, /npm ci --omit=dev/)
    assert.match(SCRIPT, /npm ci --omit=dev/)

    // The two failure conditions that job asserts on, reproduced verbatim rather than paraphrased.
    assert.match(SCRIPT, /ERR_MODULE_NOT_FOUND\|Cannot find \(package\|module\)/)
    assert.match(SCRIPT, /Database connection error/)
  })
})

describe('scripts/verify-ci.sh’s quarantine lane is report-only', () => {
  // The #2686 <-> #2692 contract: the lane runs on both sides and fails neither. Report-only on
  // both sides is what makes verify-ci and quality.yml agree on the pass/fail verdict regardless of
  // which of the two landed first. See docs/decisions/flaky-test-quarantine.md.
  test('it runs npm run test:flaky in all four workspaces', () => {
    const lane = SCRIPT.slice(SCRIPT.indexOf('if [ "$RUN_FLAKY" = \'1\' ]'))
    assert.match(lane, /for workspace in backend frontend blocks e2e/)
    assert.match(lane, /npm run test:flaky/)

    for (const workspace of ['backend', 'frontend', 'blocks', 'e2e']) {
      const scripts = JSON.parse(read(`${workspace}/package.json`)).scripts
      assert.ok(
        typeof scripts['test:flaky'] === 'string',
        `${workspace}/package.json has no test:flaky script for the lane to invoke`
      )
    }
  })

  test('a failing lane never fails the run', () => {
    const laneStart = SCRIPT.indexOf('if [ "$RUN_FLAKY" = \'1\' ]')
    const lane = SCRIPT.slice(laneStart, SCRIPT.indexOf('print_summary', laneStart))

    assert.ok(
      !/\bdie\b|\bexit 1\b/.test(lane),
      'the quarantine lane can fail the run, which contradicts the report-only contract this ' +
        'command shares with quality.yml (OpenProject #2692)'
    )
    assert.match(lane, /report-only -- does not fail this run/)
  })
})

describe('scripts/verify-ci.sh is runnable and states its own bar', () => {
  test('it is executable and has a bash shebang', () => {
    const mode = fs.statSync(path.join(REPO_ROOT, SCRIPT_PATH)).mode
    assert.ok((mode & 0o111) !== 0, `${SCRIPT_PATH} is not executable`)
    assert.ok(SCRIPT.startsWith('#!/usr/bin/env bash\n'))
  })

  test('backend/package.json exposes it as verify:ci', () => {
    const scripts = JSON.parse(read('backend/package.json')).scripts
    assert.equal(scripts['verify:ci'], 'bash ../scripts/verify-ci.sh')
  })

  test('it refuses to run outside the pinned image unless explicitly overridden', () => {
    // The Node check reads the pin rather than repeating it, so bumping the image cannot leave a
    // stale literal here (or in the script) claiming parity with a version nothing runs.
    assert.match(SCRIPT, /ARG NODE_VERSION=/)
    assert.ok(
      !/26\.8\.1/.test(SCRIPT),
      'the script hard-codes a Node version instead of reading .devcontainer/Dockerfile’s pin'
    )
    assert.match(SCRIPT, /VERIFY_CI_ALLOW_HOST/)
    assert.match(SCRIPT, /DATABASE_URL is unset/)
  })

  test('it surfaces what did NOT run beside its green verdict', () => {
    // docs/testing-audit/backend.md's finding: a default `npm run test` silently skips roughly a
    // fifth of the backend suite. A verification command that prints "green" over that is a weaker
    // promise than it reads as, so the count is part of the output rather than the scrollback.
    //
    // It counts the reporter's `# SKIP` markers, not its `skipped N` summary line: this codebase
    // skips at the `describe(..., { skip: ... })` level, which node reports as `skipped 0`.
    assert.match(SCRIPT, /grep -c '# SKIP'/)
    assert.match(SCRIPT, /green does not mean everything ran/)
  })

  test('CLAUDE.md documents the bar and names the command', () => {
    const claudeMd = read('CLAUDE.md')
    assert.match(
      claudeMd,
      /verify-ci\.sh/,
      'CLAUDE.md does not name the verification command, which is the only place the bar reaches ' +
        'the sessions that need it (OpenProject #2686)'
    )
    assert.match(claudeMd, /verify:ci/)
  })
})
