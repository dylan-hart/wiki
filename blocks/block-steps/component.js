export class BlockStepsElement extends HTMLElement {
  static definition = {
    block: 'steps',
    name: 'Steps',
    description: 'Draws a numbered list as a sequence of steps.',
    icon: 'tabler:list-numbers',
    template: `1. First step

   What to do, and anything else that belongs with it.

2. Second step

   What to do next.

3. Done`
  }

  connectedCallback() {
    if (!this.style.display) {
      this.style.display = 'block'
    }
    this._applyStart()
  }

  _applyStart() {
    const list = this.querySelector(':scope > ol[start]')
    const start = Number.parseInt(list?.getAttribute('start') ?? '', 10)
    if (list && Number.isFinite(start)) {
      list.style.setProperty('counter-reset', `cardinal-step ${start - 1}`)
    }
  }
}

window.customElements.define('block-steps', BlockStepsElement)
