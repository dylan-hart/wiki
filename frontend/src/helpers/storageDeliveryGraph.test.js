import { describe, expect, it } from 'vitest'

import { generateGraph } from './storageDeliveryGraph'

/**
 * The diagram is a pure function of the site's storage targets, so what it draws for a given set of
 * them can be asserted directly -- which is the point of lifting it out of `AdminStorage.vue`, whose
 * own coverage only ever got as far as "a graph rendered with some nodes in it".
 *
 * `t` is the identity function here: every label is a key, so a node's `name` says which string it
 * would have shown without a message bundle standing in the way.
 */
const t = (key) => key

const CONTENT_TYPES = ['images', 'documents', 'others', 'large']

function target(overrides = {}) {
  return {
    module: 's3',
    title: 'Amazon S3',
    icon: '/_assets/icons/s3.svg',
    isEnabled: true,
    contentTypes: { activeTypes: [...CONTENT_TYPES] },
    assetDelivery: {
      isDirectAccessSupported: false,
      directAccess: false,
      isStreamingSupported: false,
      streaming: false
    },
    ...overrides
  }
}

describe('generateGraph', () => {
  it('always seeds the reader, the pages node and the wiki behind it', () => {
    const { nodes, edges, layouts } = generateGraph([], t)

    expect(Object.keys(nodes)).toEqual(expect.arrayContaining(['user', 'pages', 'pages_wiki']))
    expect(nodes.pages_wiki.name).toBe('Wiki.js')
    expect(edges.user_pages).toEqual({ source: 'user', target: 'pages' })
    expect(layouts.nodes.user).toEqual({ x: -30, y: 30 })
  })

  it('draws one node per content type, each reachable from the reader', () => {
    const { nodes, edges } = generateGraph([], t)

    for (const type of CONTENT_TYPES) {
      expect(nodes[type]).toBeDefined()
      expect(edges[`user_${type}`]).toEqual({ source: 'user', target: type })
    }
  })

  it('marks a content type nothing serves as a missing origin, and highlights the path', () => {
    const { nodes, paths } = generateGraph([], t)

    expect(nodes.images_wiki.name).toBe('admin.storage.missingOrigin')
    expect(paths).toHaveLength(CONTENT_TYPES.length)
    expect(paths[0]).toEqual({ edges: ['images_db_in'], color: '#f03a4755' })
  })

  it('routes a content type the db holds through the wiki, with no missing-origin marker', () => {
    const { nodes, edges, paths } = generateGraph(
      [target({ module: 'db', contentTypes: { activeTypes: ['images'] } })],
      t
    )

    expect(nodes.images_wiki.name).toBe('Wiki.js')
    expect(edges.images_db_in).toEqual({ source: 'images', target: 'images_wiki' })
    expect(edges.images_db_out).toEqual({ source: 'images_wiki', target: 'images' })
    // -> Only the three types this db target does not hold are still origin-less
    expect(paths).toHaveLength(CONTENT_TYPES.length - 1)
  })

  it('prefers a direct-access target, putting it between the type and the wiki', () => {
    const { nodes, edges, layouts } = generateGraph(
      [
        target({
          assetDelivery: {
            isDirectAccessSupported: true,
            directAccess: true,
            isStreamingSupported: true,
            streaming: true
          }
        })
      ],
      t
    )

    expect(nodes.images_s3.name).toBe('Amazon S3')
    expect(edges.images_s3_in).toEqual({ source: 'images', target: 'images_s3' })
    // -> Direct access puts the provider nearer the reader than the wiki
    expect(layouts.nodes.images_s3.x).toBe(60)
    expect(layouts.nodes.images_wiki.x).toBe(120)
  })

  it('falls back to a streaming target, with the wiki in front of the provider', () => {
    const { nodes, edges, layouts } = generateGraph(
      [
        target({
          assetDelivery: {
            isDirectAccessSupported: false,
            directAccess: false,
            isStreamingSupported: true,
            streaming: true
          }
        })
      ],
      t
    )

    expect(nodes.images_s3.name).toBe('Amazon S3')
    expect(edges.images_wiki_in).toEqual({ source: 'images', target: 'images_wiki' })
    // -> Streaming puts the wiki between the reader and the provider, the other way round
    expect(layouts.nodes.images_wiki.x).toBe(60)
    expect(layouts.nodes.images_s3.x).toBe(120)
  })

  it('ignores a disabled target, and a target that does not hold the type', () => {
    const { nodes } = generateGraph(
      [
        target({
          isEnabled: false,
          assetDelivery: { isStreamingSupported: true, streaming: true }
        }),
        target({
          module: 'sftp',
          contentTypes: { activeTypes: ['documents'] },
          assetDelivery: { isStreamingSupported: true, streaming: true }
        })
      ],
      t
    )

    expect(nodes.images_s3).toBeUndefined()
    expect(nodes.images_wiki.name).toBe('admin.storage.missingOrigin')
    expect(nodes.documents_sftp).toBeDefined()
  })
})
