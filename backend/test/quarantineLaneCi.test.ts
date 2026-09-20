/**
 * A report-only step is a step that cannot fail, and a step that cannot fail is a step nobody
 * reads — so every claim below is one that, if it silently stopped holding, would leave the lane
 * running but pointless. Whether a real run actually renders the annotation or the summary needs a
 * real runner and is not asserted.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const LANE_SCRIPT_REL = 'scripts/ci-quarantine-lane.sh'
const LANE_SCRIPT = path.join(REPO_ROOT, LANE_SCRIPT_REL)

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

    // The lane is a report on top of a run whose real suites already had their say.
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
    // The same suite must not run twice per commit, so the e2e lane is wired in one workflow only.
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
    // A non-zero exit is what turns the step's marker from a plain green tick into GitHub's
    // failed-but-continued one; a script swallowing the failure would leave the lane unread.
    assert.match(
      source,
      /if \[ "\$\{#failed_lanes\[@\]\}" -gt 0 \]; then\n\s*exit 1/,
      'the script must exit non-zero when a lane fails; continue-on-error on the step is what makes that report-only'
    )
  })

  test('the lane script invokes test:flaky, never a hand-written glob', () => {
    // Going through `npm run test:flaky` is what lets a workspace's own package.json stay the
    // single statement of its lane's command.
    assert.match(fs.readFileSync(LANE_SCRIPT, 'utf8'), /npm run --silent test:flaky/)
  })
})
