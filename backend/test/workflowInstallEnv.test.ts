/**
 * OpenProject #3438 ("Skip onnxruntime-node's CUDA download in CI installs"), under Feature #3426.
 *
 * `onnxruntime-node` (transitive via `@huggingface/transformers`) has a postinstall that, on
 * linux/x64, downloads a CUDA nupkg from nuget.org. CI has no GPU, so that request can only ever
 * fail a job on a nuget outage. onnxruntime-node 1.30.0's `script/install-utils.js` reads
 * `ONNXRUNTIME_NODE_INSTALL=skip` (its non-deprecated switch; `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`
 * is marked deprecated there) and exits the postinstall early. The CPU binding ships inside the
 * tarball, so skipping loses nothing the semantic-search path needs.
 *
 * Every workflow step that installs backend/ dependencies must set it. The switch lives in the
 * step's own `env:` -- not a job- or workflow-level one -- so the check is per install step, and a
 * newly added backend install step without it fails here rather than on a nuget outage.
 *
 * Deliberately not covered: the `npm ci --omit=dev` in build.yml's "Prepare build archive" (no
 * `working-directory`, `cd _dist/backend`) and `dev/build/Dockerfile`. Those build the artifacts
 * users receive; skipping there would drop the CUDA execution provider from the shipped product.
 *
 * Structural check against `.github/workflows/*.yml`, same category as `workflowTimeouts.test.ts`
 * and `devcontainerCiParity.test.ts`.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const WORKFLOW_FILES = [
  '.github/workflows/quality.yml',
  '.github/workflows/build.yml',
  '.github/workflows/e2e.yml',
  '.github/workflows/release.yml'
]

const SKIP_ENV = 'ONNXRUNTIME_NODE_INSTALL'
const SKIP_VALUE = 'skip'

type Step = {
  name?: string
  run?: string
  'working-directory'?: string
  env?: Record<string, unknown>
}
type Workflow = { jobs: Record<string, { steps?: Step[] }> }

/** True when a shell `run:` body invokes `npm ci` or `npm install` (any flags). */
const runsNpmInstall = (run: string): boolean => /(^|[\s;&|])npm\s+(ci|install|i)(\s|$)/m.test(run)

/** Every step, in every job of every workflow, that installs into backend/ via `working-directory`. */
function backendInstallSteps(): { file: string; job: string; step: Step }[] {
  const found: { file: string; job: string; step: Step }[] = []
  for (const file of WORKFLOW_FILES) {
    const workflow = load(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')) as Workflow
    for (const [job, def] of Object.entries(workflow.jobs)) {
      for (const step of def.steps ?? []) {
        if (
          step['working-directory'] === 'backend' &&
          typeof step.run === 'string' &&
          runsNpmInstall(step.run)
        ) {
          found.push({ file, job, step })
        }
      }
    }
  }
  return found
}

describe('CI backend installs skip onnxruntime-node CUDA download (#3438)', () => {
  const steps = backendInstallSteps()

  test('the workflows still have backend install steps to check (the check cannot pass vacuously)', () => {
    // quality.yml (production-boot-smoke-test + quality), build.yml, e2e.yml, release.yml.
    assert.ok(
      steps.length >= 5,
      `expected at least 5 backend install steps across the workflows, found ${steps.length}`
    )
  })

  for (const { file, job, step } of steps) {
    test(`${file} > ${job} > "${step.name ?? step.run}" sets ${SKIP_ENV}=${SKIP_VALUE}`, () => {
      assert.equal(
        String(step.env?.[SKIP_ENV]),
        SKIP_VALUE,
        `an install step in backend/ must set \`env: ${SKIP_ENV}: ${SKIP_VALUE}\` so onnxruntime-node's postinstall does not fetch its CUDA package from nuget.org`
      )
    })
  }
})
