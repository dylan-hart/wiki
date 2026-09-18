import { describe, expect, it, vi } from 'vitest'

import { createWikiBlockNodeView } from './wikiBlockNodeView'

function fakeNode(block, props = {}) {
  return { type: { name: 'wikiBlock' }, attrs: { block, props } }
}

describe('createWikiBlockNodeView()', () => {
  it('mounts the real custom element, tagged and classed, not a stand-in', () => {
    const view = createWikiBlockNodeView()({ node: fakeNode('tabs') })
    expect(view.dom.tagName.toLowerCase()).toBe('block-tabs')
    expect(view.dom.classList.contains('wiki-block-node')).toBe(true)
  })

  it('points contentDOM at the element itself, so ProseMirror manages its children directly', () => {
    const view = createWikiBlockNodeView()({ node: fakeNode('tab') })
    expect(view.contentDOM).toBe(view.dom)
  })

  it('writes the node’s props onto the element as real HTML attributes', () => {
    const view = createWikiBlockNodeView()({
      node: fakeNode('pdf', { label: 'First tab', 'hide-toolbar': true })
    })
    expect(view.dom.getAttribute('label')).toBe('First tab')
    expect(view.dom.getAttribute('hide-toolbar')).toBe('')
  })

  it('asks the caller to load a not-yet-defined tag, once, on mount', () => {
    const loadBlock = vi.fn()
    createWikiBlockNodeView({ loadBlock })({ node: fakeNode('countdown') })
    expect(loadBlock).toHaveBeenCalledExactlyOnceWith('block-countdown')
  })

  it('does not ask to load a tag the browser has already upgraded', () => {
    class FakeBlock extends HTMLElement {}
    window.customElements.define('block-wikiblock-nodeview-fixture', FakeBlock)
    const loadBlock = vi.fn()
    createWikiBlockNodeView({ loadBlock })({
      node: fakeNode('wikiblock-nodeview-fixture')
    })
    expect(loadBlock).not.toHaveBeenCalled()
  })

  it('leaves the tag alone with no loadBlock option at all', () => {
    expect(() => createWikiBlockNodeView()({ node: fakeNode('map') })).not.toThrow()
  })

  describe('update()', () => {
    it('reconciles attributes and reports success for the same block', () => {
      const view = createWikiBlockNodeView()({ node: fakeNode('tab', { label: 'One' }) })
      const applied = view.update(fakeNode('tab', { label: 'Two' }))
      expect(applied).toBe(true)
      expect(view.dom.getAttribute('label')).toBe('Two')
    })

    it('drops an attribute the updated node no longer declares', () => {
      const view = createWikiBlockNodeView()({
        node: fakeNode('tab', { label: 'One', icon: 'tabler:home' })
      })
      view.update(fakeNode('tab', { label: 'One' }))
      expect(view.dom.hasAttribute('icon')).toBe(false)
    })

    it('keeps the class attribute across an update', () => {
      const view = createWikiBlockNodeView()({ node: fakeNode('tab', {}) })
      view.update(fakeNode('tab', { label: 'One' }))
      expect(view.dom.classList.contains('wiki-block-node')).toBe(true)
    })

    it('refuses an update that would change the element’s own tag, asking for a rebuild instead', () => {
      const view = createWikiBlockNodeView()({ node: fakeNode('tab') })
      expect(view.update(fakeNode('tabs'))).toBe(false)
    })

    it('refuses an update carrying a different node type', () => {
      const view = createWikiBlockNodeView()({ node: fakeNode('tab') })
      const otherType = { type: { name: 'paragraph' }, attrs: { block: 'tab', props: {} } }
      expect(view.update(otherType)).toBe(false)
    })
  })

  describe('ignoreMutation()', () => {
    it('ignores a mutation inside the element’s own shadow root', () => {
      const view = createWikiBlockNodeView()({ node: fakeNode('tabs') })
      const shadow = view.dom.attachShadow({ mode: 'open' })
      const inner = document.createElement('span')
      shadow.appendChild(inner)
      expect(view.ignoreMutation({ target: inner })).toBe(true)
    })

    it('does not ignore a mutation on a light-DOM child, which is real editor content', () => {
      const view = createWikiBlockNodeView()({ node: fakeNode('tabs') })
      const child = document.createElement('p')
      view.dom.appendChild(child)
      expect(view.ignoreMutation({ target: child })).toBe(false)
    })
  })
})
