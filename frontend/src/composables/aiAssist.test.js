import { describe, expect, it } from 'vitest'

import { aiErrorMessage, aiGenerate, fetchAiStatus } from './aiAssist.js'

const t = (key) => `t:${key}`

function httpError(status, data) {
  const err = new Error(`Request failed with status code ${status}`)
  err.response = { status }
  err.data = data
  return err
}

describe('fetchAiStatus', () => {
  it('reads the status route for the given site', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ available: true, reason: null, cap: 50, remaining: 12, retryAfter: null })
    })

    const status = await fetchAiStatus('site-1')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/ai/status')
    expect(status).toEqual({
      available: true,
      reason: null,
      cap: 50,
      remaining: 12,
      retryAfter: null
    })
  })

  it('treats anything but a literal true as unavailable', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ available: 'yes' }) })

    expect((await fetchAiStatus('site-1')).available).toBe(false)
  })

  it('answers unavailable rather than throwing when the request fails', async () => {
    API_CLIENT.get.mockImplementationOnce(() => {
      throw httpError(404)
    })

    const status = await fetchAiStatus('site-1')

    expect(status.available).toBe(false)
    expect(status.reason).toBe('error')
  })

  it('answers unavailable without a request when there is no site', async () => {
    const status = await fetchAiStatus('')

    expect(status.available).toBe(false)
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})

describe('aiGenerate', () => {
  it('posts the action and selection and returns the generated text', async () => {
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ text: 'Shorter.' }) })

    const text = await aiGenerate('site-1', {
      action: 'summarize',
      text: 'A long passage.',
      pageId: 'page-1',
      path: 'docs/intro',
      locale: 'en'
    })

    expect(text).toBe('Shorter.')
    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/ai/generate', {
      json: {
        action: 'summarize',
        text: 'A long passage.',
        pageId: 'page-1',
        path: 'docs/intro',
        locale: 'en'
      }
    })
  })

  it('leaves out an empty prompt and page id', async () => {
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve({ text: 'x' }) })

    await aiGenerate('site-1', { action: 'rewrite', text: 'a', path: 'new-page', locale: 'en' })

    expect(API_CLIENT.post.mock.calls[0][1].json).toEqual({
      action: 'rewrite',
      text: 'a',
      path: 'new-page',
      locale: 'en'
    })
  })

  it('lets a failed request reject so the caller can explain it', async () => {
    API_CLIENT.post.mockImplementationOnce(() => {
      throw httpError(503)
    })

    await expect(
      aiGenerate('site-1', { action: 'rewrite', text: 'a', path: 'p', locale: 'en' })
    ).rejects.toThrow('503')
  })
})

describe('aiErrorMessage', () => {
  it.each([
    [401, 'editor.ai.errors.signIn'],
    [403, 'editor.ai.errors.forbidden'],
    [429, 'editor.ai.errors.capReached'],
    [503, 'editor.ai.errors.unavailable']
  ])('explains a %i with its own string', (status, key) => {
    expect(aiErrorMessage(httpError(status, { message: 'server text' }), t)).toBe(`t:${key}`)
  })

  it("falls back to the server's message for any other failure", () => {
    expect(aiErrorMessage(httpError(400, { message: 'Text is too long.' }), t)).toBe(
      'Text is too long.'
    )
  })

  it('falls back to the generic string when there is nothing better', () => {
    expect(aiErrorMessage({}, t)).toBe('t:editor.ai.errors.failed')
  })
})
