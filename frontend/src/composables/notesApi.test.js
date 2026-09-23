import { describe, expect, it } from 'vitest'

import { notesApi } from './notesApi'

function answer(method, payload) {
  API_CLIENT[method].mockReturnValue({ json: () => Promise.resolve(payload) })
}

describe('notesApi', () => {
  const api = notesApi('site-1')

  it('lists sections from a bare array or a wrapped body', async () => {
    answer('get', [{ id: 's1' }])
    expect(await api.listSections()).toEqual([{ id: 's1' }])
    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/notes/sections')

    answer('get', { sections: [{ id: 's2' }] })
    expect(await api.listSections()).toEqual([{ id: 's2' }])

    answer('get', undefined)
    expect(await api.listSections()).toEqual([])
  })

  it('lists a section’s notes by query string', async () => {
    answer('get', { notes: [{ id: 'n1', excerpt: 'Hi' }] })
    expect(await api.listNotes('s1')).toEqual([{ id: 'n1', excerpt: 'Hi' }])
    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/notes', {
      searchParams: { sectionId: 's1' }
    })
  })

  it('reads one note with its content', async () => {
    answer('get', { note: { id: 'n1', content: 'x' } })
    expect(await api.getNote('n1')).toEqual({ id: 'n1', content: 'x' })
    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/notes/n1')
  })

  it('creates a section and a note, unwrapping the row', async () => {
    answer('post', { section: { id: 's9', title: 'New' } })
    expect(await api.createSection({ title: 'New' })).toEqual({ id: 's9', title: 'New' })
    expect(API_CLIENT.post).toHaveBeenLastCalledWith('sites/site-1/notes/sections', {
      json: { title: 'New' }
    })

    answer('post', { id: 'n9', sectionId: 's9' })
    expect(await api.createNote({ sectionId: 's9' })).toEqual({ id: 'n9', sectionId: 's9' })
    expect(API_CLIENT.post).toHaveBeenLastCalledWith('sites/site-1/notes', {
      json: { sectionId: 's9', title: undefined, content: undefined }
    })
  })

  it('sends updates, deletes and reorders to the pinned routes', async () => {
    answer('put', { updatedAt: 'now' })
    answer('delete', { ok: true })

    expect(await api.updateNote('n1', { content: 'c' })).toEqual({ updatedAt: 'now' })
    expect(API_CLIENT.put).toHaveBeenLastCalledWith('sites/site-1/notes/n1', {
      json: { content: 'c' }
    })

    await api.updateSection('s1', { title: 'T' })
    expect(API_CLIENT.put).toHaveBeenLastCalledWith('sites/site-1/notes/sections/s1', {
      json: { title: 'T' }
    })

    await api.reorderSections(['s2', 's1'])
    expect(API_CLIENT.put).toHaveBeenLastCalledWith('sites/site-1/notes/sections/order', {
      json: { ids: ['s2', 's1'] }
    })

    await api.reorderNotes('s1', ['n2', 'n1'])
    expect(API_CLIENT.put).toHaveBeenLastCalledWith('sites/site-1/notes/order', {
      json: { sectionId: 's1', ids: ['n2', 'n1'] }
    })

    await api.deleteNote('n1')
    expect(API_CLIENT.delete).toHaveBeenLastCalledWith('sites/site-1/notes/n1')

    await api.deleteSection('s1')
    expect(API_CLIENT.delete).toHaveBeenLastCalledWith('sites/site-1/notes/sections/s1')
  })

  it('uploads an image as one multipart file', async () => {
    answer('post', { id: 'i1', url: '/_api/sites/site-1/notes/n1/images/i1' })
    const file = new File(['x'], 'shot.png', { type: 'image/png' })

    expect(await api.uploadImage('n1', file)).toEqual({
      id: 'i1',
      url: '/_api/sites/site-1/notes/n1/images/i1'
    })
    const [url, opts] = API_CLIENT.post.mock.calls.at(-1)
    expect(url).toBe('sites/site-1/notes/n1/images')
    expect(opts.body).toBeInstanceOf(FormData)
    expect(opts.body.get('file').name).toBe('shot.png')
  })
})
