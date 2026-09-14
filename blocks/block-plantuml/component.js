import { DiagramImageElement } from '../shared/diagram-image.js'

/** The default server, which is the one PlantUML runs for everybody. */
const DEFAULT_SERVER = 'https://www.plantuml.com/plantuml'

/**
 * Block PlantUML
 */
export class BlockPlantumlElement extends DiagramImageElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'plantuml',
    name: 'PlantUML',
    description:
      'Draws a PlantUML diagram — sequence, class, state, activity, mindmap, gantt and the rest.',
    icon: 'tabler:schema',
    /*
      Fenced, and named `plantuml` so the source is what it says it is. The fence is also what keeps
      markdown off it: `->` survives, but `--` becomes a dash, a line opening with `*` or `#` is read
      as a list or a heading, and an indented line becomes a code block of its own.

      Passed to the server exactly as written, `@startuml` included — which is why a `@startmindmap`
      or a `@startgantt` works here too. Wrapping it in `@startuml` on the author's behalf would rule
      every one of those out.
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
        // -> Written out rather than taken from DEFAULT_SERVER above: the manifest is read out of this
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
     * Site-level field an admin sets once for the whole site, as opposed to the `server` prop above,
     * which an author sets per use in the editor for the reader's own browser to fetch from directly.
     * This one is what the backend itself renders against for a server-side request — OpenProject
     * task 2223 — so unlike the prop, an admin-set value here is validated at write time
     * (`models/blocks.ts`) to be an http(s) URL with no query string or fragment. Same field name as
     * the `server` prop above on purpose — an admin's site-wide server is what `propDefault()`
     * (`frontend/src/helpers/blocks.js`) seeds the picker's `server` field from, the same way
     * block-map's `config`/`props` pair does for its own tile-server fields.
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
