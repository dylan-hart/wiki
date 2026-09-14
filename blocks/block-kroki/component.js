import { DiagramImageElement } from '../shared/diagram-image.js'

/** The default server, which is the one Kroki runs for everybody. */
const DEFAULT_SERVER = 'https://kroki.io'

/**
 * Everything Kroki draws, as it is named in a URL.
 *
 * Kroki is a front end to a shelf of diagram tools rather than one of its own, so unlike PlantUML the
 * language has to be named alongside the source — the same text is a valid diagram in more than one
 * of these. `diagramsnet` is the one Kroki documents that is left out: the public server answers 503
 * for it.
 */
const TYPES = [
  'actdiag',
  'blockdiag',
  'bpmn',
  'bytefield',
  'c4plantuml',
  'd2',
  'dbml',
  'ditaa',
  'erd',
  'excalidraw',
  'graphviz',
  'mermaid',
  'nomnoml',
  'nwdiag',
  'packetdiag',
  'pikchr',
  'plantuml',
  'rackdiag',
  'seqdiag',
  'structurizr',
  'svgbob',
  'symbolator',
  'tikz',
  'umlet',
  'vega',
  'vegalite',
  'wavedrom',
  'wireviz'
]

/**
 * Block Kroki
 */
export class BlockKrokiElement extends DiagramImageElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'kroki',
    name: 'Kroki',
    description:
      'Draws a diagram through a Kroki server — Graphviz, D2, BPMN, Vega, Structurizr, TikZ and two dozen more.',
    icon: 'tabler:topology-star',
    /*
      Fenced, and named `kroki` whatever the diagram language turns out to be, since that is the block
      reading it. The fence is also what keeps markdown off the source: `--` becomes a dash, a line
      opening with `*` or `#` is read as a list or a heading, an indented line becomes a code block of
      its own, and `_` opens emphasis.
    */
    template: `\`\`\`kroki
digraph G {
  Hello -> World
}
\`\`\``,
    props: [
      {
        name: 'type',
        type: 'select',
        label: 'Diagram type',
        // -> Written out rather than taken from TYPES above: the manifest is read out of this file's
        //    syntax tree at build time, where a name is just a name
        options: [
          'actdiag',
          'blockdiag',
          'bpmn',
          'bytefield',
          'c4plantuml',
          'd2',
          'dbml',
          'ditaa',
          'erd',
          'excalidraw',
          'graphviz',
          'mermaid',
          'nomnoml',
          'nwdiag',
          'packetdiag',
          'pikchr',
          'plantuml',
          'rackdiag',
          'seqdiag',
          'structurizr',
          'svgbob',
          'symbolator',
          'tikz',
          'umlet',
          'vega',
          'vegalite',
          'wavedrom',
          'wireviz'
        ],
        hint: 'The language the source is written in. Kroki cannot tell from the text alone.',
        default: 'graphviz'
      },
      {
        name: 'server',
        type: 'string',
        label: 'Server',
        hint: 'Kroki server to draw with. The public one when left empty.',
        default: 'https://kroki.io'
      },
      {
        name: 'format',
        type: 'select',
        label: 'Format',
        options: ['svg', 'png'],
        hint: 'svg stays sharp at any size; png is there for the few types that draw nothing else.',
        default: 'svg'
      },
      {
        name: 'caption',
        type: 'string',
        label: 'Caption',
        hint: 'Shown under the diagram.'
      },
      {
        name: 'align',
        type: 'select',
        label: 'Alignment',
        options: ['left', 'center'],
        default: 'left'
      }
    ],
    /**
     * Site-level fields an admin sets once for the whole site, as opposed to `props` above, which an
     * author sets per use in the editor. Same field name as the `server` prop above on purpose — an
     * admin's site-wide server is what `propDefault()` (`frontend/src/helpers/blocks.js`) seeds the
     * picker's `server` field from, the same way block-map's `config`/`props` pair does for its own
     * tile-server fields.
     */
    config: [
      {
        name: 'server',
        type: 'string',
        label: 'Server',
        hint: 'Kroki server to draw with, for every use of this block on the site. The public one when left empty.',
        default: 'https://kroki.io'
      }
    ]
  }

  static properties = {
    /**
     * The diagram language the source is written in
     * @type {string}
     */
    type: { type: String }
  }

  constructor() {
    super()
    this.type = 'graphviz'
  }

  _defaultServer() {
    return DEFAULT_SERVER
  }

  _fenceName() {
    return 'kroki'
  }

  _alt() {
    return this.caption || `${this.type} diagram`
  }

  _engine() {
    return 'kroki'
  }

  /** Kroki needs to be told which of its languages `source` is written in — it cannot tell from the
   *  text alone. Falls back to `graphviz` for an unrecognised `type`, the same fallback the old
   *  GET-URL path used. */
  _extraBody() {
    return { diagramType: TYPES.includes(this.type) ? this.type : 'graphviz' }
  }
}

window.customElements.define('block-kroki', BlockKrokiElement)
