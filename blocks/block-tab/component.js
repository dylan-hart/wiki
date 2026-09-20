/**
 * One panel of a `block-tabs`, which reads its `label` and `icon`, builds the strip and shows or
 * hides it — this element draws nothing, and leaves its content in the light DOM so the article's
 * own stylesheet reaches it. It is registered at all only because the page view fetches a component
 * for every undefined element it finds in a page.
 */
export class BlockTabElement extends HTMLElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * has to stay a plain literal.
   *
   * `isChild` keeps it out of the picker and the admin area: a tab is not something to insert, or
   * to switch off, separately from the tabs it belongs to. Declared regardless, because it is what
   * lets the tag and its attributes survive being saved.
   */
  static definition = {
    block: 'tab',
    name: 'Tab',
    description: 'One panel of a set of tabs.',
    icon: 'tabler:layout-navbar',
    isChild: true,
    props: [
      {
        name: 'label',
        type: 'string',
        label: 'Label',
        hint: 'What the tab is called in the strip.',
        required: true
      },
      {
        name: 'icon',
        type: 'string',
        label: 'Icon',
        hint: 'Iconify reference drawn to the left of the label, e.g. tabler:brand-python.'
      },
      {
        name: 'header',
        type: 'number',
        label: 'Header Level',
        hint: 'From 1 to 6, lists the tab in the page contents under its label, and clicking it there opens the tab. Empty is an ordinary tab.'
      }
    ]
  }

  connectedCallback() {
    /*
      Set inline because the app resets the display of everything in a page, and only when nothing
      has been set already: the two components arrive in separate files in either order, and the
      parent hides the panels it is not showing -- overwriting that would leave every panel on
      screen. Visible rather than hidden, so a page whose tab strip never arrives still reads.
    */
    if (!this.style.display) {
      this.style.display = 'block'
    }
  }
}

window.customElements.define('block-tab', BlockTabElement)
