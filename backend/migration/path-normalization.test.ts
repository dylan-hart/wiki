import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { StagedPage } from './content-staging.ts'
import { assignTreePaths, normalizeMigratedPath, normalizeSegment } from './path-normalization.ts'

describe('normalizeSegment', () => {
  test('lowercases a segment', () => {
    assert.equal(normalizeSegment('FooBar'), 'foobar')
  })

  test('folds underscores to hyphens', () => {
    assert.equal(normalizeSegment('my_page_name'), 'my-page-name')
  })

  test('leaves an already-legal segment untouched but for casing', () => {
    assert.equal(normalizeSegment('already-legal-123'), 'already-legal-123')
  })

  test('rejects a segment that is still illegal after folding', () => {
    // Not reachable through 2.x's own rePagePath in practice, but this module must not crash on it.
    assert.equal(normalizeSegment('has a space'), null)
  })
})

describe('normalizeMigratedPath', () => {
  test('splits a multi-segment path into parentPath + fileName', () => {
    const result = normalizeMigratedPath('Guide/Getting_Started')
    assert.deepEqual(result, {
      parentPath: 'guide',
      fileName: 'getting-started',
      path: 'guide/getting-started'
    })
  })

  test('a single-segment path has an empty parentPath (site root)', () => {
    const result = normalizeMigratedPath('Welcome')
    assert.deepEqual(result, { parentPath: '', fileName: 'welcome', path: 'welcome' })
  })

  test('strips leading and trailing slashes', () => {
    const result = normalizeMigratedPath('/guide/intro/')
    assert.deepEqual(result, { parentPath: 'guide', fileName: 'intro', path: 'guide/intro' })
  })

  test('reports empty-path for a path that is blank once trimmed', () => {
    const result = normalizeMigratedPath('   ')
    assert.equal('reason' in result && result.reason, 'empty-path')
  })

  test('reports invalid-segment for consecutive slashes (empty segment)', () => {
    const result = normalizeMigratedPath('guide//intro')
    assert.equal('reason' in result && result.reason, 'invalid-segment')
  })

  test('reports invalid-segment for a character no amount of folding fixes', () => {
    const result = normalizeMigratedPath('guide/a b')
    assert.equal('reason' in result && result.reason, 'invalid-segment')
  })
})

describe('assignTreePaths', () => {
  const noneExist = () => false

  test('assigns a simple page to its normalized location', async () => {
    const { assignments, failures } = await assignTreePaths(
      [{ oldId: 1, path: 'Guide/Intro', locale: 'en' }],
      { siteId: 'site-1', existingEntry: noneExist }
    )
    assert.equal(failures.length, 0)
    assert.deepEqual(assignments, [
      { oldId: 1, locale: 'en', parentPath: 'guide', fileName: 'intro', path: 'guide/intro' }
    ])
  })

  test('reports a case-fold collision between two distinct pages in the same locale, overwriting neither', async () => {
    const { assignments, failures } = await assignTreePaths(
      [
        { oldId: 1, path: 'FooBar', locale: 'en' },
        { oldId: 2, path: 'foobar', locale: 'en' }
      ],
      { siteId: 'site-1', existingEntry: noneExist }
    )
    assert.equal(assignments.length, 0)
    assert.equal(failures.length, 2)
    assert.deepEqual(
      failures.map((f) => f.oldId),
      [1, 2]
    )
    for (const failure of failures) {
      assert.equal(failure.reason, 'sibling-collision')
      assert.match(failure.message, /same tree location/)
    }
  })

  test('does not flag a case-fold collision across different locales', async () => {
    const { assignments, failures } = await assignTreePaths(
      [
        { oldId: 1, path: 'FooBar', locale: 'en' },
        { oldId: 2, path: 'foobar', locale: 'fr' }
      ],
      { siteId: 'site-1', existingEntry: noneExist }
    )
    assert.equal(failures.length, 0)
    assert.equal(assignments.length, 2)
  })

  test('locale variants of the same 2.x page share folderPath/fileName but land as distinct rows', async () => {
    const { assignments, failures } = await assignTreePaths(
      [
        { oldId: 1, path: 'about', locale: 'en' },
        { oldId: 2, path: 'about', locale: 'fr' },
        { oldId: 3, path: 'about', locale: 'de' }
      ],
      { siteId: 'site-1', existingEntry: noneExist }
    )
    assert.equal(failures.length, 0)
    assert.equal(assignments.length, 3)
    for (const a of assignments) {
      assert.equal(a.parentPath, '')
      assert.equal(a.fileName, 'about')
    }
    assert.deepEqual(assignments.map((a) => a.locale).sort(), ['de', 'en', 'fr'])
  })

  test('reports a page whose normalized path collides with an existing 3.0 tree entry, without crashing the run', async () => {
    const existingEntry = (siteId: string, locale: string, parentPath: string, fileName: string) =>
      siteId === 'site-1' && locale === 'en' && parentPath === '' && fileName === 'taken'
    const { assignments, failures } = await assignTreePaths(
      [
        { oldId: 1, path: 'taken', locale: 'en' },
        { oldId: 2, path: 'free', locale: 'en' }
      ],
      { siteId: 'site-1', existingEntry }
    )
    assert.deepEqual(
      assignments.map((a) => a.oldId),
      [2]
    )
    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.oldId, 1)
    assert.equal(failures[0]?.reason, 'existing-entry-collision')
  })

  test('a malformed path is reported as a per-page failure, not a thrown error', async () => {
    const { assignments, failures } = await assignTreePaths(
      [
        { oldId: 1, path: 'guide//intro', locale: 'en' },
        { oldId: 2, path: 'guide/ok', locale: 'en' }
      ],
      { siteId: 'site-1', existingEntry: noneExist }
    )
    assert.deepEqual(
      assignments.map((a) => a.oldId),
      [2]
    )
    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.oldId, 1)
    assert.equal(failures[0]?.reason, 'invalid-segment')
  })

  test('a redirect-type 2.x page is normalized exactly like any other page', async () => {
    const { assignments, failures } = await assignTreePaths(
      [{ oldId: 1, path: 'Old_Name', locale: 'en' }],
      { siteId: 'site-1', existingEntry: noneExist }
    )
    assert.equal(failures.length, 0)
    assert.deepEqual(assignments, [
      { oldId: 1, locale: 'en', parentPath: '', fileName: 'old-name', path: 'old-name' }
    ])
  })

  test('accepts a real StagedPage[] (content-staging.ts output) directly, unmodified', async () => {
    // Task 738 is expected to pass `ContentStagingResult.pages` straight through — this pins that
    // `PathAssignmentInput` stays a structural subset of `StagedPage` rather than drifting apart.
    const buildStagedPage = (overrides: Partial<StagedPage>): StagedPage => ({
      oldId: 1,
      path: 'welcome',
      locale: 'en',
      title: 'Welcome',
      hash: 'hash-1',
      description: null,
      content: '# Welcome',
      render: '<h1>Welcome</h1>',
      toc: null,
      contentType: 'markdown',
      isPrivate: false,
      privateNS: null,
      isPublished: true,
      publishStartDate: null,
      publishEndDate: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      extra: {},
      editorKey: null,
      tags: [],
      authorId: 'actor-1',
      creatorId: 'actor-1',
      sourceAuthorId: null,
      sourceCreatorId: null,
      localeSiblingOldIds: [],
      history: [],
      ...overrides
    })
    const stagedPages: StagedPage[] = [
      buildStagedPage({ oldId: 1, path: 'Getting_Started', locale: 'en' }),
      buildStagedPage({ oldId: 2, path: 'redirect-me', locale: 'en', contentType: 'redirect' })
    ]

    const { assignments, failures } = await assignTreePaths(stagedPages, {
      siteId: 'site-1',
      existingEntry: () => false
    })

    assert.equal(failures.length, 0)
    assert.deepEqual(
      assignments.map((a) => ({ oldId: a.oldId, fileName: a.fileName })),
      [
        { oldId: 1, fileName: 'getting-started' },
        { oldId: 2, fileName: 'redirect-me' }
      ]
    )
  })

  test('preserves input order in both assignments and failures', async () => {
    const { assignments, failures } = await assignTreePaths(
      [
        { oldId: 3, path: 'c', locale: 'en' },
        { oldId: 1, path: 'guide//broken', locale: 'en' },
        { oldId: 2, path: 'a', locale: 'en' }
      ],
      { siteId: 'site-1', existingEntry: noneExist }
    )
    assert.deepEqual(
      assignments.map((a) => a.oldId),
      [3, 2]
    )
    assert.deepEqual(
      failures.map((f) => f.oldId),
      [1]
    )
  })
})
