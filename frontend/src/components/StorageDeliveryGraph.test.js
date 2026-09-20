import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import StorageDeliveryGraph from './StorageDeliveryGraph.vue'

const componentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'StorageDeliveryGraph.vue'),
  'utf8'
)

/**
 * The fixtures are hand-built rather than run through
 * `helpers/storageDeliveryGraph.js#generateGraph()`, so each case exercises exactly one geometry
 * rule in isolation.
 */

function mountGraph(props) {
  return mount(StorageDeliveryGraph, {
    props: { paths: [], dark: false, ariaLabel: 'Delivery paths', ...props }
  })
}

describe('StorageDeliveryGraph.vue - nodes', () => {
  it('renders one <g> per node, positioned at its layout coordinates', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: {},
      layouts: { nodes: { a: { x: 10, y: 20 }, b: { x: -5, y: 0 } } }
    })

    const a = wrapper.find('[data-node-id="a"]')
    expect(a.exists()).toBe(true)
    expect(a.attributes('transform')).toBe('translate(10 20)')

    const b = wrapper.find('[data-node-id="b"]')
    expect(b.attributes('transform')).toBe('translate(-5 0)')
  })

  it('falls back to a fixed position when a node has no layout entry', () => {
    const wrapper = mountGraph({
      nodes: { orphan: { name: 'Orphan' } },
      edges: {},
      layouts: { nodes: {} }
    })

    expect(wrapper.find('[data-node-id="orphan"]').attributes('transform')).toBe('translate(0 0)')
  })

  it('uses the node color, falling back to the default blue', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A', color: '#161b22' }, b: { name: 'B' } },
      edges: {},
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 30, y: 0 } } }
    })

    expect(wrapper.find('[data-node-id="a"] rect').attributes('fill')).toBe('#161b22')
    expect(wrapper.find('[data-node-id="b"] rect').attributes('fill')).toBe('#1976D2')
  })

  it('makes a node fully circular when its borderRadius equals the node radius, per the "user" node', () => {
    const wrapper = mountGraph({
      nodes: { user: { name: 'User', borderRadius: 16 } },
      edges: {},
      layouts: { nodes: { user: { x: 0, y: 0 } } }
    })

    const rect = wrapper.find('[data-node-id="user"] rect')
    const rx = Number(rect.attributes('rx'))
    const width = Number(rect.attributes('width'))
    expect(rx).toBeCloseTo(width / 2, 5)
  })

  it('draws an icon only when the node has an .svg icon', () => {
    const wrapper = mountGraph({
      nodes: {
        withIcon: { name: 'With', icon: '/_assets/icons/a.svg' },
        withoutIcon: { name: 'Without' }
      },
      edges: {},
      layouts: { nodes: { withIcon: { x: 0, y: 0 }, withoutIcon: { x: 30, y: 0 } } }
    })

    const iconNode = wrapper.find('[data-node-id="withIcon"] image')
    expect(iconNode.exists()).toBe(true)
    expect(iconNode.attributes('href')).toBe('/_assets/icons/a.svg')

    expect(wrapper.find('[data-node-id="withoutIcon"] image').exists()).toBe(false)
  })

  it('labels each node with its name, positioned below the node', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'Amazon S3' } },
      edges: {},
      layouts: { nodes: { a: { x: 0, y: 0 } } }
    })

    const label = wrapper.find('text.storage-delivery-graph__label[data-node-id="a"]')
    expect(label.text()).toBe('Amazon S3')
    expect(Number(label.attributes('y'))).toBeGreaterThan(0)
    expect(label.attributes('text-anchor')).toBe('middle')
  })
})

describe('StorageDeliveryGraph.vue - node hover', () => {
  /**
   * `jsdom`/`happy-dom` run no layout engine and never evaluate `:hover`, so this guards the rule
   * text at source level rather than the style it renders.
   */
  it('keeps a :hover rule on the node group that scales it and highlights its fill', () => {
    const hoverRuleMatch = componentSource.match(/\.storage-delivery-graph__node:hover\s*{([^}]*)}/)
    expect(hoverRuleMatch).not.toBeNull()
    expect(hoverRuleMatch[1]).toMatch(/transform:\s*scale\(/)

    const rectHoverRuleMatch = componentSource.match(
      /\.storage-delivery-graph__node:hover rect\s*{([^}]*)}/
    )
    expect(rectHoverRuleMatch).not.toBeNull()
    expect(rectHoverRuleMatch[1]).toMatch(/filter:/)
  })

  it('marks the node group cursor: pointer, the old library’s visible click affordance', () => {
    expect(componentSource).toMatch(/\.storage-delivery-graph__node\s*{[^}]*cursor:\s*pointer/)
  })

  /**
   * A CSS `transform` REPLACES an SVG presentation-attribute `transform` on the SAME element rather
   * than composing with it, so sharing one `<g>` snaps every node to local origin on hover.
   */
  it('keeps the positioning transform and the hover-scale class on separate, nested elements', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' } },
      edges: {},
      layouts: { nodes: { a: { x: 10, y: 20 } } }
    })

    const outer = wrapper.find('[data-node-id="a"]')
    expect(outer.attributes('transform')).toBe('translate(10 20)')
    expect(outer.classes()).not.toContain('storage-delivery-graph__node')

    const inner = outer.find('.storage-delivery-graph__node')
    expect(inner.exists()).toBe(true)
    expect(inner.attributes('transform')).toBeUndefined()
    expect(inner.attributes('data-node-id')).toBeUndefined()
  })
})

describe('StorageDeliveryGraph.vue - edges', () => {
  it('trims a lone edge off both node boundaries rather than drawing center-to-center', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: { ab: { source: 'a', target: 'b' } },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } }
    })

    const line = wrapper.find('line.storage-delivery-graph__edge')
    expect(Number(line.attributes('x1'))).toBeGreaterThan(0)
    expect(Number(line.attributes('x2'))).toBeLessThan(100)
    expect(Number(line.attributes('y1'))).toBe(0)
    expect(Number(line.attributes('y2'))).toBe(0)
  })

  it('spreads two edges sharing the same node pair into symmetric parallel lines', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: {
        ab: { source: 'a', target: 'b' },
        ba: { source: 'b', target: 'a' }
      },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } }
    })

    const lines = wrapper.findAll('line.storage-delivery-graph__edge')
    expect(lines).toHaveLength(2)

    const y1s = lines.map((l) => Number(l.attributes('y1')))
    // -> The perpendicular of a horizontal edge is vertical, so a symmetric spread shows up in y.
    expect(y1s[0]).not.toBe(y1s[1])
    expect(y1s[0] + y1s[1]).toBeCloseTo(0, 5)
  })

  it('spreads three edges sharing the same node pair with one staying on the centerline', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: {
        ab1: { source: 'a', target: 'b' },
        ab2: { source: 'b', target: 'a' },
        ab3: { source: 'b', target: 'a', color: '#02c39a' }
      },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } }
    })

    const y1s = wrapper
      .findAll('line.storage-delivery-graph__edge')
      .map((l) => Number(l.attributes('y1')))
    expect(y1s).toHaveLength(3)
    expect(y1s.some((y) => Math.abs(y) < 1e-6)).toBe(true)
    const nonZero = y1s.filter((y) => Math.abs(y) >= 1e-6)
    expect(nonZero[0]).toBeCloseTo(-nonZero[1], 5)
  })

  it('marks an animate:false edge with a static dasharray and no flow animation class', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: { ab: { source: 'a', target: 'b', animate: false, color: '#f03a47' } },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } }
    })

    const line = wrapper.find('line.storage-delivery-graph__edge')
    expect(line.classes()).not.toContain('storage-delivery-graph__edge--animated')
    expect(line.attributes('stroke')).toBe('#f03a47')
    const normal = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: { ab: { source: 'a', target: 'b' } },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } }
    }).find('line.storage-delivery-graph__edge')
    expect(Number(line.attributes('stroke-dasharray'))).toBeGreaterThan(
      Number(normal.attributes('stroke-dasharray'))
    )
  })

  it('applies the flow animation to an animated edge, with a slower cycle at a lower animationSpeed', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } },
      edges: {
        ab: { source: 'a', target: 'b' },
        ac: { source: 'a', target: 'c', animationSpeed: 25 }
      },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 0, y: 100 } } }
    })

    const lines = wrapper.findAll('line.storage-delivery-graph__edge')
    expect(lines[0].classes()).toContain('storage-delivery-graph__edge--animated')

    const defaultDuration = Number.parseFloat(
      lines[0].attributes('style').match(/animation-duration:\s*([\d.]+)s/)[1]
    )
    const slowDuration = Number.parseFloat(
      lines[1].attributes('style').match(/animation-duration:\s*([\d.]+)s/)[1]
    )
    expect(slowDuration).toBeGreaterThan(defaultDuration)
  })

  /**
   * The unit stands in for the interpolation itself, which jsdom/happy-dom cannot show: bare, the
   * `calc()` resolves to an untyped <number> and the flow degrades to a discrete jump.
   */
  it('gives --sdg-dash-len an explicit length unit so the animation interpolates continuously', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: { ab: { source: 'a', target: 'b' } },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } }
    })

    const style = wrapper.find('line.storage-delivery-graph__edge').attributes('style')
    expect(style).toMatch(/--sdg-dash-len:\s*[\d.]+px/)
  })
})

describe('StorageDeliveryGraph.vue - missing-origin overlay', () => {
  it('draws an overlay line reusing its edge’s own trimmed endpoints', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: { ab: { source: 'a', target: 'b', animate: false, color: '#f03a47' } },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } },
      paths: [{ edges: ['ab'], color: '#f03a4755' }]
    })

    const edge = wrapper.find('line.storage-delivery-graph__edge')
    const overlay = wrapper.find('line.storage-delivery-graph__path')

    expect(overlay.exists()).toBe(true)
    expect(overlay.attributes('stroke')).toBe('#f03a4755')
    expect(overlay.attributes('x1')).toBe(edge.attributes('x1'))
    expect(overlay.attributes('x2')).toBe(edge.attributes('x2'))
  })

  it('ignores a path referencing an edge id that does not exist', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: { ab: { source: 'a', target: 'b' } },
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } },
      paths: [{ edges: ['nonexistent'], color: '#f03a4755' }]
    })

    expect(wrapper.find('line.storage-delivery-graph__path').exists()).toBe(false)
  })
})

describe('StorageDeliveryGraph.vue - viewBox and theme', () => {
  it('derives a viewBox that grows to fit nodes further from the origin', () => {
    const small = mountGraph({
      nodes: { a: { name: 'A' } },
      edges: {},
      layouts: { nodes: { a: { x: 0, y: 0 } } }
    })
    const large = mountGraph({
      nodes: { a: { name: 'A' }, b: { name: 'B' } },
      edges: {},
      layouts: { nodes: { a: { x: 0, y: 0 }, b: { x: 300, y: 300 } } }
    })

    const widthOf = (wrapper) => Number(wrapper.find('svg').attributes('viewBox').split(' ')[2])
    expect(widthOf(large)).toBeGreaterThan(widthOf(small))
  })

  it('falls back to a non-degenerate viewBox with no nodes at all', () => {
    const wrapper = mountGraph({ nodes: {}, edges: {}, layouts: { nodes: {} } })
    const [, , width, height] = wrapper.find('svg').attributes('viewBox').split(' ').map(Number)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })

  it('keeps the light background and black label color when dark is false', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' } },
      edges: {},
      layouts: { nodes: { a: { x: 0, y: 0 } } },
      dark: false
    })

    expect(wrapper.find('.storage-delivery-graph__background').attributes('fill')).toBe('#fff')
    expect(wrapper.find('.storage-delivery-graph__label').attributes('fill')).toBe('#000000')
  })

  it('switches to the dark card surface and a light label color when dark is true', () => {
    const wrapper = mountGraph({
      nodes: { a: { name: 'A' } },
      edges: {},
      layouts: { nodes: { a: { x: 0, y: 0 } } },
      dark: true
    })

    expect(wrapper.find('.storage-delivery-graph__background').attributes('fill')).toBe(
      'var(--color-dark-3)'
    )
    expect(wrapper.find('.storage-delivery-graph__label').attributes('fill')).toBe('#e8eaed')
  })
})
