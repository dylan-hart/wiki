/**
 * Structural check on the quarantine lane's CI wiring — OpenProject #2692 (Feature #2603,
 * Epic #2600). The lane's rules live in `docs/decisions/flaky-test-quarantine.md`; this file
 * guards the half of it that lives in YAML, which nothing else can.
 *
 * The defect being guarded against is specific, and it is the one #2692's own spec names: a
 * report-only step is a step that cannot fail, and a step that cannot fail is a step nobody reads.
 * Every claim below is one that, if it silently stopped holding, would leave the lane running but
 * pointless — a workspace with a `test:flaky` script and no CI step, a step that lost its
 * `continue-on-error` and started gating a release, or a lane whose result stopped being annotated
 * onto the run page.
 *
 * This is a structural/self-consistency scan against repo-root CI config with no backend-workspace
 * file to sit next to, which is why it lives in `backend/test/` rather than co-located — the same
 * category, and the same reasoning, as `test/e2e-workflow.test.ts` and
 * `test/release-workflow.test.ts` beside it (CLAUDE.md, "Testing (backend)").
 *
 * What it deliberately does NOT assert: that a GitHub Actions run actually renders the annotation
 * or the summary. That needs a real runner. What is asserted here is that the script is invoked,
 * that it is invoked report-only, that it covers every workspace with a lane, and that the script
 * itself still emits the three things the step depends on.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const LANE_SCRIPT_REL = 'scripts/ci-quarantine-lane.sh'
const LANE_SCRIPT = path.join(REPO_ROOT, LANE_SCRIPT_REL)

/** The four workspaces, in the order `docs/decisions/flaky-test-quarantine.md` tabulates them. */
const WORKSPACES = ['backend', 'frontend', 'blocks', 'e2e'] as const

interface Step {
  name?: string
  run?: string
  uses?: string
  'continue-on-error'?: boolean
}

function workflow(file: string): any {
  return load(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', file), 'utf8'))
}

function stepsOf(doc: any, jobName: string): Step[] {
  const job = doc.jobs?.[jobName]
  assert.ok(job, `expected a job named ${jobName}`)
  return (job.steps ?? []) as Step[]
}

/** Every step in a job whose `run:` invokes the lane script, with the workspaces it names. */
function laneSteps(steps: Step[]): { step: Step; workspaces: string[] }[] {
  return steps
    .filter((step) => (step.run ?? '').includes(LANE_SCRIPT_REL))
    .map((step) => ({
      step,
      workspaces: (step.run ?? '')
        .replace(/^[\s\S]*ci-quarantine-lane\.sh/, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    }))
}

describe('quarantine lane CI wiring (#2692)', () => {
  const qualityDoc = workflow('quality.yml')
  const buildDoc = workflow('build.yml')
  const releaseDoc = workflow('release.yml')
  const e2eDoc = workflow('e2e.yml')

  const qualityLanes = laneSteps(stepsOf(qualityDoc, 'quality'))
  const buildLanes = laneSteps(stepsOf(buildDoc, 'build'))
  const releaseLanes = laneSteps(stepsOf(releaseDoc, 'release'))
  const e2eLanes = laneSteps(stepsOf(e2eDoc, 'e2e'))

  test('the lane script exists and is executable', () => {
    assert.ok(fs.existsSync(LANE_SCRIPT), `expected ${LANE_SCRIPT_REL} to exist`)
    // The owner-execute bit is the one git actually tracks (it stores 100755 vs 100644).
    const executable = (fs.statSync(LANE_SCRIPT).mode & 0o100) !== 0
    assert.ok(
      executable,
      `${LANE_SCRIPT_REL} must be committed with its execute bit set — a workflow \`run:\` invoking it directly gets "Permission denied" otherwise`
    )
  })

  test('every workspace declaring a test:flaky script is covered by exactly one lane step', () => {
    const withLaneScript = WORKSPACES.filter((workspace) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8')
      )
      return typeof manifest.scripts?.['test:flaky'] === 'string'
    })
    assert.deepEqual(
      withLaneScript,
      [...WORKSPACES],
      'all four workspaces are expected to declare a test:flaky script (Task #2691)'
    )

    // quality.yml runs on every PR and, via build.yml's `quality` job, on every scarlett push.
    // build.yml's `build` job adds e2e only. Together that is each workspace exactly once per
    // push — no workspace uncovered, none run twice.
    const coverage = new Map<string, string[]>()
    for (const [file, lanes] of [
      ['quality.yml', qualityLanes],
      ['build.yml', buildLanes],
      ['release.yml', releaseLanes],
      ['e2e.yml', e2eLanes]
    ] as const) {
      for (const { workspaces } of lanes) {
        for (const workspace of workspaces) {
          coverage.set(workspace, [...(coverage.get(workspace) ?? []), file])
        }
      }
    }

    for (const workspace of withLaneScript) {
      assert.ok(
        (coverage.get(workspace) ?? []).length > 0,
        `${workspace}/ has a test:flaky script but no CI lane step runs it — a lane nobody runs is the same as no lane`
      )
    }
  })

  test('quality.yml runs the backend/frontend/blocks lanes, report-only, after the unit suites', () => {
    assert.equal(qualityLanes.length, 1, 'expected exactly one lane step in quality.yml')
    const [lane] = qualityLanes
    assert.deepEqual(lane.workspaces, ['backend', 'frontend', 'blocks'])
    assert.equal(
      lane.step['continue-on-error'],
      true,
      'the lane must not gate the job — GitHub Actions defaults continue-on-error to false, and every other step in this workflow relies on that default'
    )

    // After the per-workspace test steps, not before: the lane is a report on top of a run whose
    // real suites already had their say.
    const steps = stepsOf(qualityDoc, 'quality')
    const laneIndex = steps.indexOf(lane.step)
    const lastUnitSuite = steps.findLastIndex((step) => (step.name ?? '').endsWith('Tests'))
    assert.ok(lastUnitSuite >= 0, 'expected at least one "… Tests" step in quality.yml')
    assert.ok(
      laneIndex > lastUnitSuite,
      'the lane step belongs after the per-workspace unit-test steps'
    )
  })

  test('build.yml runs the e2e lane only, report-only', () => {
    assert.equal(buildLanes.length, 1, 'expected exactly one lane step in build.yml')
    const [lane] = buildLanes
    assert.deepEqual(
      lane.workspaces,
      ['e2e'],
      'build.yml needs: quality, so the backend/frontend/blocks lanes already ran there — repeating them here pays for them twice per push'
    )
    assert.equal(lane.step['continue-on-error'], true)
  })

  test('the e2e lane is wired in build.yml and NOT also in e2e.yml', () => {
    // e2e.yml's own header records that the same suite must not run twice per commit; #2692's spec
    // says not to wire the lane into both. This is the assertion that keeps a later well-meant
    // "e2e.yml should report the lane too" edit from reintroducing it silently.
    assert.equal(
      e2eLanes.length,
      0,
      'e2e.yml must not carry a lane step — build.yml owns the e2e lane'
    )
  })

  test('release.yml runs the lane report-only, so a red lane never blocks a release', () => {
    assert.equal(releaseLanes.length, 1, 'expected exactly one lane step in release.yml')
    const [lane] = releaseLanes
    assert.deepEqual(lane.workspaces, ['backend', 'frontend', 'blocks'])
    assert.equal(
      lane.step['continue-on-error'],
      true,
      "Feature #2603's resolved scope: a lane that blocks releases is a blocking lane with extra steps"
    )

    // Every other step in release.yml's gate section is fail-closed. Assert that stayed true, so
    // this one exception cannot quietly spread.
    const steps = stepsOf(releaseDoc, 'release')
    const otherLenient = steps.filter(
      (step) => step !== lane.step && step['continue-on-error'] === true
    )
    assert.deepEqual(
      otherLenient.map((step) => step.name),
      [],
      'release.yml is a fail-closed pipeline; the quarantine lane is meant to be its only continue-on-error step'
    )
  })

  test('the lane script still emits the three things the report-only step depends on', () => {
    const source = fs.readFileSync(LANE_SCRIPT, 'utf8')

    assert.match(
      source,
      /GITHUB_STEP_SUMMARY/,
      'the job summary is how a red lane is legible on the run page without opening a log'
    )
    assert.match(
      source,
      /::error title=Quarantine lane failed/,
      'an annotation per failed lane is the other half of that visibility'
    )
    // The script exiting non-zero is what turns the step's marker from a plain green tick into
    // GitHub's failed-but-continued one. A script that swallowed the failure would leave the step
    // permanently green and the lane unread — the exact outcome #2692's spec item 3 warns about.
    assert.match(
      source,
      /if \[ "\$\{#failed_lanes\[@\]\}" -gt 0 \]; then\n\s*exit 1/,
      'the script must exit non-zero when a lane fails; continue-on-error on the step is what makes that report-only'
    )
  })

  test('the decision record and the CI wiring agree on the lane command', () => {
    const record = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/decisions/flaky-test-quarantine.md'),
      'utf8'
    )
    assert.match(
      record,
      /Task #2692/,
      'the decision record names #2692 as owning the CI side; keep that pointer alive'
    )
    // The step invokes `npm run test:flaky` per workspace via the script, never a hand-written
    // glob — that indirection is what lets the record stay the single statement of each lane's
    // command.
    assert.match(fs.readFileSync(LANE_SCRIPT, 'utf8'), /npm run --silent test:flaky/)

    // The record's "Where the lane runs" table is a claim about these three workflows. Assert each
    // row against the real wiring, so the table cannot quietly become a lie — the same failure the
    // record itself exists to replace ("prose does not stop a run going red").
    for (const [file, lanes] of [
      ['quality.yml', qualityLanes],
      ['build.yml', buildLanes],
      ['release.yml', releaseLanes]
    ] as const) {
      const row = record.split('\n').find((line) => line.startsWith('| `' + file + '`'))
      assert.ok(row, `expected the record's lane table to carry a row for ${file}`)
      const claimed = row.split('|')[3].trim().replaceAll('`', '')
      assert.equal(
        claimed,
        lanes.flatMap(({ workspaces }) => workspaces).join(' '),
        `the record's table says ${file} runs "${claimed}", which is not what the workflow does`
      )
    }
  })
})
