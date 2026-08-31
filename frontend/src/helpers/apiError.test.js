import { describe, expect, it } from 'vitest'

import { apiErrorMessage } from '@/helpers/apiError'

/** Builds a ky-shaped `HTTPError` (its own parsed body sitting in `.data`, its own generic message in `.message`). */
function httpError({ data, message = 'Request failed with status code 503' } = {}) {
  const err = new Error(message)
  err.data = data
  return err
}

describe('apiErrorMessage', () => {
  it('prefers the server-sent message when the response carried one', () => {
    const err = httpError({
      data: {
        ok: false,
        error: 'Forbidden',
        statusCode: 403,
        message: 'You do not have permission to do this.'
      }
    })
    expect(apiErrorMessage(err)).toBe('You do not have permission to do this.')
  })

  it('falls back to the error message when the response carried no message', () => {
    const err = httpError({ data: undefined, message: 'Request failed with status code 503' })
    expect(apiErrorMessage(err)).toBe('Request failed with status code 503')
  })

  it('falls back to the supplied fallback when neither the server nor the error offered anything', () => {
    const err = new Error()
    err.message = ''
    expect(apiErrorMessage(err, 'An unexpected error occured.')).toBe(
      'An unexpected error occured.'
    )
  })
})
