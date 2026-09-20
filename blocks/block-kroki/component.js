import { DiagramImageElement } from '../shared/diagram-image.js'

const DEFAULT_SERVER = 'https://kroki.io'

/**
 * Every language Kroki draws, as it is named in a request. `diagramsnet` is the one Kroki documents
 * that is deliberately left out: the public server answers 503 for it.
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

export class BlockKrokiElement extends DiagramImageElement {
  /**
   * Read out of the source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'kroki',
    name: 'Kroki',
    description:
      'Draws a diagram through a Kroki server — Graphviz, D2, BPMN, Vega, Structurizr, TikZ and two dozen more.',
    icon: 'tabler:topology-star',
    /*
      Named `kroki` whatever the diagram language is, since that is the block reading it. The fence
      is what keeps markdown off the source — dashes, `*`, `#`, `_` and indentation all mean
      something to it.
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
        //    syntax tree at build time, where an identifier has no value to look up
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
     * Set once per site by an admin, where `props` above are per use by an author. The field name
     * matches the `server` prop deliberately: `propDefault()` (`frontend/src/helpers/blocks.js`)
     * seeds the picker's field from the site-wide value by name.
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

  /** Kroki has to be told which of its languages the source is in — it cannot tell from the text
   *  alone, since the same text is a valid diagram in more than one of them. */
  _extraBody() {
    return { diagramType: TYPES.includes(this.type) ? this.type : 'graphviz' }
  }
}

window.customElements.define('block-kroki', BlockKrokiElement)
