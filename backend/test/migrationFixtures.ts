/**
 * Shared fixtures for the 2.5.x-to-3.0 migration suites (TEST-F10).
 *
 * Three things were copied verbatim across `migration/`'s test files: a two-line async generator over
 * an array (6 identical copies), an 18-line `SourceConnector` whose every entity generator throws
 * `NotYetImplementedError` (9 copies in 8 files), and a 22-field 2.5.x `pages` row (13 copies in 8
 * files). None of them is what any of those suites is about — a phase test cares which generators it
 * DOES supply, and a staging test cares which one field it changed.
 */
import { NotYetImplementedError } from '../migration/connector.ts'
import type { SourceConnector, SourceRecord } from '../migration/connector.ts'
import type { StagedPage } from '../migration/content-staging.ts'

/** An `AsyncGenerator` over a plain array — what a `SourceConnector` generator has to hand back. */
export async function* iterate<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item
  }
}

/**
 * A `SourceConnector` whose every entity generator throws `NotYetImplementedError`, with `overrides`
 * spread over it.
 *
 * The throwing default is the point: a phase test names exactly the generators the phase under test
 * is supposed to read, and any OTHER one it reaches for fails loudly rather than quietly yielding an
 * empty sequence that reads as "nothing to import".
 */
export function stubSourceConnector(overrides: Partial<SourceConnector> = {}): SourceConnector {
  const notImplemented = (method: string) => () => {
    throw new NotYetImplementedError(method, 'not needed by this test')
  }
  return {
    kind: 'postgres',
    connect: async () => {},
    disconnect: async () => {},
    describe: async () => ({ kind: 'postgres', location: 'stub', notes: [] }),
    users: notImplemented('users'),
    groups: notImplemented('groups'),
    pages: notImplemented('pages'),
    pageHistory: notImplemented('pageHistory'),
    tags: notImplemented('tags'),
    navigation: notImplemented('navigation'),
    settings: notImplemented('settings'),
    comments: notImplemented('comments'),
    assets: notImplemented('assets'),
    ...overrides
  } as SourceConnector
}

/** One 2.5.x `pages` row as a connector yields it — the 22 columns the importers actually read. */
export function makeSourcePageRow(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 1,
    path: 'welcome',
    localeCode: 'en',
    title: 'Welcome',
    hash: 'hash-1',
    description: 'The home page',
    content: '# Welcome',
    render: '<h1>Welcome</h1>',
    toc: null,
    contentType: 'markdown',
    isPrivate: false,
    privateNS: null,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    createdAt: '2023-01-01T00:00:00.000Z',
    updatedAt: '2023-09-01T00:00:00.000Z',
    extra: {},
    editorKey: 'markdown',
    tags: [],
    authorId: 10,
    creatorId: 10,
    ...overrides
  } as SourceRecord
}

/** One `StagedPage` — the shape `content-staging.ts` hands the page importer, ids already resolved. */
export function makeStagedPage(overrides: Partial<StagedPage> = {}): StagedPage {
  return {
    oldId: 1,
    path: 'welcome',
    locale: 'en',
    title: 'Welcome',
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
    editorKey: 'markdown',
    tags: [],
    authorId: 'actor-1',
    creatorId: 'actor-1',
    history: [],
    ...overrides
  }
}

/**
 * `CREATE TABLE` statements for the 2.5.x tables a connector suite stands up in a real Postgres.
 *
 * A per-table OPT-IN map rather than one "make me a 2.5.x database" call: several of
 * `migration/connectors/postgres.test.ts`'s fixtures are deliberately narrower than the real schema,
 * because what they prove is that `checkShape()` REJECTS them. `pages` is the minimal shape
 * `checkShape()` introspects; `pagesFull` is the wider one a suite that actually reads page content
 * needs.
 */
export const LEGACY_SCHEMA_DDL: Record<string, string> = {
  pages: `
    CREATE TABLE pages (
      id serial PRIMARY KEY,
      path varchar NOT NULL,
      hash varchar NOT NULL,
      "authorId" integer,
      "creatorId" integer,
      "contentType" varchar NOT NULL
    )
  `,
  pagesFull: `
    CREATE TABLE pages (
      id serial PRIMARY KEY,
      path varchar NOT NULL,
      "localeCode" varchar NOT NULL DEFAULT 'en',
      hash varchar NOT NULL,
      title varchar NOT NULL,
      "contentType" varchar NOT NULL,
      "authorId" integer,
      "creatorId" integer
    )
  `,
  users: `
    CREATE TABLE users (
      id serial PRIMARY KEY,
      email varchar NOT NULL,
      "providerKey" varchar NOT NULL DEFAULT 'local',
      "tfaIsActive" boolean NOT NULL DEFAULT false
    )
  `,
  groups: `
    CREATE TABLE groups (
      id serial PRIMARY KEY,
      name varchar NOT NULL,
      permissions json NOT NULL,
      "pageRules" json NOT NULL,
      "redirectOnLogin" varchar NOT NULL DEFAULT '/'
    )
  `,
  userGroups: `
    CREATE TABLE "userGroups" (
      id serial PRIMARY KEY,
      "userId" integer NOT NULL,
      "groupId" integer NOT NULL
    )
  `,
  knexMigrations: `
    CREATE TABLE knex_migrations (
      id serial PRIMARY KEY,
      name varchar NOT NULL
    )
  `,
  pageHistory: `
    CREATE TABLE "pageHistory" (
      id serial PRIMARY KEY,
      "pageId" integer,
      path varchar NOT NULL,
      "localeCode" varchar NOT NULL DEFAULT 'en',
      title varchar NOT NULL,
      action varchar NOT NULL DEFAULT 'updated',
      "versionDate" varchar NOT NULL,
      "authorId" integer
    )
  `,
  tags: `
    CREATE TABLE tags (
      id serial PRIMARY KEY,
      tag varchar NOT NULL UNIQUE,
      title varchar
    )
  `,
  pageTags: `
    CREATE TABLE "pageTags" (
      id serial PRIMARY KEY,
      "pageId" integer,
      "tagId" integer
    )
  `,
  pageHistoryTags: `
    CREATE TABLE "pageHistoryTags" (
      id serial PRIMARY KEY,
      "pageId" integer,
      "tagId" integer
    )
  `,
  navigation: `
    CREATE TABLE navigation (
      key varchar PRIMARY KEY,
      config json
    )
  `,
  settings: `
    CREATE TABLE settings (
      key varchar PRIMARY KEY,
      value json,
      "updatedAt" varchar NOT NULL
    )
  `,
  authentication: `
    CREATE TABLE authentication (
      key varchar PRIMARY KEY,
      "isEnabled" boolean NOT NULL DEFAULT false,
      config json NOT NULL,
      "selfRegistration" boolean NOT NULL DEFAULT false,
      "domainWhitelist" json NOT NULL,
      "autoEnrollGroups" json NOT NULL,
      "order" integer NOT NULL DEFAULT 0,
      "strategyKey" varchar NOT NULL DEFAULT '',
      "displayName" varchar NOT NULL DEFAULT ''
    )
  `,
  storage: `
    CREATE TABLE storage (
      key varchar PRIMARY KEY,
      "isEnabled" boolean NOT NULL DEFAULT false,
      mode varchar NOT NULL DEFAULT 'push',
      config json,
      "syncInterval" varchar,
      state json
    )
  `,
  comments: `
    CREATE TABLE comments (
      id serial PRIMARY KEY,
      content text NOT NULL,
      "createdAt" varchar NOT NULL,
      "updatedAt" varchar NOT NULL,
      "pageId" integer,
      "authorId" integer,
      render text NOT NULL DEFAULT '',
      name varchar NOT NULL DEFAULT '',
      email varchar NOT NULL DEFAULT '',
      ip varchar NOT NULL DEFAULT '',
      "replyTo" integer NOT NULL DEFAULT 0
    )
  `,
  assetFolders: `
    CREATE TABLE "assetFolders" (
      id serial PRIMARY KEY,
      name varchar NOT NULL,
      slug varchar NOT NULL,
      "parentId" integer
    )
  `,
  assets: `
    CREATE TABLE assets (
      id serial PRIMARY KEY,
      filename varchar NOT NULL,
      hash varchar NOT NULL,
      ext varchar NOT NULL,
      kind varchar NOT NULL DEFAULT 'binary',
      mime varchar NOT NULL DEFAULT 'application/octet-stream',
      "fileSize" integer,
      metadata json,
      "createdAt" varchar NOT NULL,
      "updatedAt" varchar NOT NULL,
      "folderId" integer,
      "authorId" integer
    )
  `,
  assetData: `
    CREATE TABLE "assetData" (
      id integer PRIMARY KEY,
      data bytea NOT NULL
    )
  `
}
