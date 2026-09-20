import { DiagramImageElement } from '../shared/diagram-image.js'

const DEFAULT_SERVER = 'https://www.plantuml.com/plantuml'

export class BlockPlantumlElement extends DiagramImageElement {
  /**
   * Read out of this source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'plantuml',
    name: 'PlantUML',
    description:
      'Draws a PlantUML diagram — sequence, class, state, activity, mindmap, gantt and the rest.',
    icon: 'tabler:schema',
    /*
      Fenced to keep markdown off the source: `--` becomes a dash, a line opening with `*` or `#` is
      read as a list or a heading, and an indented line becomes a code block of its own. What is
      inside goes to the server exactly as written, `@startuml` included — wrapping it on the
      author's behalf would rule out `@startmindmap`, `@startgantt` and the rest.
    */
    template: `\`\`\`plantuml
@startuml
Alice -> Bob : hello
Bob --> Alice : hi
@enduml
\`\`\``,
    props: [
      {
        name: 'server',
        type: 'string',
        label: 'Server',
        hint: 'PlantUML server to draw with. The public one when left empty.',
        // -> Written out rather than taken from DEFAULT_SERVER: the manifest is read out of this
        //    file's syntax tree at build time, where a name is just a name
        default: 'https://www.plantuml.com/plantuml'
      },
      {
        name: 'format',
        type: 'select',
        label: 'Format',
        options: ['svg', 'png'],
        hint: 'svg stays sharp at any size; png is there for a server with svg switched off.',
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
     * Site-level, set once by an admin, and what the backend renders against server-side — so unlike
     * the `server` prop above (a reader's own browser fetches from that one) it is validated at write
     * time in `models/blocks.ts`. Sharing the prop's field name is deliberate: the site-wide value is
     * what seeds the picker's `server` field.
     */
    config: [
      {
        name: 'server',
        type: 'string',
        label: 'Server',
        hint: "PlantUML server this wiki renders diagrams against server-side (PDF export, and any other context that draws a diagram without a reader's own browser). The public one when left empty.",
        default: 'https://www.plantuml.com/plantuml'
      }
    ]
  }

  _defaultServer() {
    return DEFAULT_SERVER
  }

  _fenceName() {
    return 'plantuml'
  }

  _alt() {
    return this.caption || 'PlantUML diagram'
  }

  _engine() {
    return 'plantuml'
  }

  _emptySourceMessage() {
    let message = super._emptySourceMessage()
    if (this.querySelector('img')) {
      // -> Something already put an image where the source should be — pasted-in markup, most
      //    likely, since nothing in this wiki's own render pipeline ever does
      message +=
        "\n\nAn image sits here instead of source text. Replace it with the diagram's PlantUML source, inside the ```plantuml fence."
    }
    return message
  }
}

window.customElements.define('block-plantuml', BlockPlantumlElement)
