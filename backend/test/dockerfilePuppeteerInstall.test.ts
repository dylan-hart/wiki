/**
 * The failure mode guarded: an `npm install` stage alongside `npm ci` is unlocked and runs every
 * postinstall under it against whatever the registry serves on the day of the image build.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DOCKERFILE = path.join(REPO_ROOT, 'dev/build/Dockerfile')

describe('dev/build/Dockerfile puppeteer install (OpenProject #2289)', () => {
  test('has no bare `npm install` — puppeteer only ever installs through the locked `npm ci`', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')
    assert.doesNotMatch(dockerfile, /npm install/)
  })
})
