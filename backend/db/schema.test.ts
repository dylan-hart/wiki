import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { comments } from './schema.ts'

describe('comments table', () => {
  const config = getTableConfig(comments)
  const columns = Object.fromEntries(config.columns.map((col) => [col.name, col]))

  it('is named comments', () => {
    assert.equal(config.name, 'comments')
  })

  it('has an id primary key defaulting to a random uuid', () => {
    assert.equal(columns.id.primary, true)
    assert.equal(columns.id.hasDefault, true)
  })

  it('requires siteId and pageId but not authorId or replyTo', () => {
    assert.equal(columns.siteId.notNull, true)
    assert.equal(columns.pageId.notNull, true)
    assert.equal(columns.authorId.notNull, false)
    assert.equal(columns.replyTo.notNull, false)
  })

  it('requires content but leaves render nullable', () => {
    assert.equal(columns.content.notNull, true)
    assert.equal(columns.render.notNull, false)
  })

  it('carries nullable guest fields sized like pageEditSubmissions', () => {
    assert.equal(columns.guestName.notNull, false)
    assert.equal(columns.guestEmail.notNull, false)
    assert.equal(columns.guestIp.notNull, false)
  })

  it('stamps createdAt and updatedAt as not-null with defaults', () => {
    assert.equal(columns.createdAt.notNull, true)
    assert.equal(columns.createdAt.hasDefault, true)
    assert.equal(columns.updatedAt.notNull, true)
    assert.equal(columns.updatedAt.hasDefault, true)
  })

  it('cascades pageId deletes and nulls out authorId on user deletion', () => {
    const fk = (name: string) =>
      config.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === name))

    const pageFk = fk('pageId')
    assert.ok(pageFk, 'expected a foreign key on pageId')
    assert.equal(getTableName(pageFk!.reference().foreignTable), 'pages')
    assert.equal(pageFk!.onDelete, 'cascade')

    const authorFk = fk('authorId')
    assert.ok(authorFk, 'expected a foreign key on authorId')
    assert.equal(getTableName(authorFk!.reference().foreignTable), 'users')
    assert.equal(authorFk!.onDelete, 'set null')

    const siteFk = fk('siteId')
    assert.ok(siteFk, 'expected a foreign key on siteId')
    assert.equal(getTableName(siteFk!.reference().foreignTable), 'sites')
  })

  it('self-references replyTo and cascades on delete, so replies do not outlive their parent', () => {
    const replyFk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === 'replyTo')
    )
    assert.ok(replyFk, 'expected a foreign key on replyTo')
    assert.equal(getTableName(replyFk!.reference().foreignTable), 'comments')
    assert.equal(replyFk!.onDelete, 'cascade')
  })

  it('indexes pageId+createdAt, siteId, authorId and replyTo', () => {
    const indexNames = config.indexes.map((idx) => idx.config.name)
    assert.ok(indexNames.includes('comments_pageId_idx'))
    assert.ok(indexNames.includes('comments_siteId_idx'))
    assert.ok(indexNames.includes('comments_authorId_idx'))
    assert.ok(indexNames.includes('comments_replyTo_idx'))

    const pageIdIdx = config.indexes.find((idx) => idx.config.name === 'comments_pageId_idx')!
    const pageIdIdxColumns = pageIdIdx.config.columns.map((c: any) => c.name)
    assert.deepEqual(pageIdIdxColumns, ['pageId', 'createdAt'])
  })
})
