import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runMigration } from './orchestrator.ts'
import type { MigrationContext, MigrationPhase, PhaseResult } from './context.ts'

function fakePhase(id: PhaseResult['phase'], calls: string[]): MigrationPhase {
  return {
    id,
    label: id,
    dependsOn: [],
    async run(): Promise<PhaseResult> {
      calls.push(id)
      return { phase: id, status: 'ok', counts: { [id]: 1 }, durationMs: 0 }
    }
  }
}

function contextStub(overrides: Partial<MigrationContext> = {}): MigrationContext {
  return {
    db: {} as any,
    source: {} as any,
    siteId: 'test-site',
    dryRun: false,
    // Task 14: required fields, unused by this orchestration-only suite.
    localStrategyId: 'test-local-strategy-uuid',
    systemGroupIds: { admin: 'test-admin-group-uuid', guest: 'test-guest-group-uuid' },
    operatorActorId: 'test-operator-uuid',
    ...overrides
  }
}

describe('runMigration', () => {
  test('runs every phase in the given order and collects results', async () => {
    const calls: string[] = []
    const phases = [
      fakePhase('settings', calls),
      fakePhase('users', calls),
      fakePhase('content', calls),
      fakePhase('assets', calls)
    ]
    const results = await runMigration(phases, contextStub())
    assert.deepEqual(calls, ['settings', 'users', 'content', 'assets'])
    assert.deepEqual(
      results.map((r) => r.phase),
      ['settings', 'users', 'content', 'assets']
    )
    assert.ok(results.every((r) => r.status === 'ok'))
  })

  test('--only runs just the selected phase(s), preserving relative order', async () => {
    const calls: string[] = []
    const phases = [
      fakePhase('settings', calls),
      fakePhase('users', calls),
      fakePhase('content', calls),
      fakePhase('assets', calls)
    ]
    const results = await runMigration(phases, contextStub(), { only: ['content', 'settings'] })
    assert.deepEqual(calls, ['settings', 'content'])
    assert.deepEqual(
      results.map((r) => r.phase),
      ['settings', 'content']
    )
  })

  test('passes the same ctx object through to every phase unchanged', async () => {
    const seen: MigrationContext[] = []
    const phase: MigrationPhase = {
      id: 'settings',
      label: 'settings',
      dependsOn: [],
      async run(ctx) {
        seen.push(ctx)
        return { phase: 'settings', status: 'ok', durationMs: 0 }
      }
    }
    const ctx = contextStub({ siteId: 'site-42', dryRun: true })
    await runMigration([phase], ctx)
    assert.equal(seen[0], ctx)
    assert.equal(seen[0].siteId, 'site-42')
    assert.equal(seen[0].dryRun, true)
  })

  test('a phase reporting status "error" does not stop later phases from running', async () => {
    const calls: string[] = []
    const failing: MigrationPhase = {
      id: 'settings',
      label: 'settings',
      dependsOn: [],
      async run() {
        calls.push('settings')
        return { phase: 'settings', status: 'error', errors: ['boom'], durationMs: 0 }
      }
    }
    const phases = [failing, fakePhase('users', calls)]
    const results = await runMigration(phases, contextStub())
    assert.deepEqual(calls, ['settings', 'users'])
    assert.equal(results[0].status, 'error')
    assert.equal(results[1].status, 'ok')
  })
})
