import { createSign } from 'node:crypto'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GROUPS_URL = 'https://admin.googleapis.com/admin/directory/v1/groups'
const SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.readonly'
const MAX_PAGES = 100
const REQUEST_TIMEOUT_MS = 15_000

interface ServiceAccountKey {
  client_email: string
  private_key: string
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function parseServiceAccountKey(raw: unknown): ServiceAccountKey {
  let parsed: any = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('ERR_STRATEGY_MISCONFIGURED')
    }
  }
  if (
    !parsed ||
    typeof parsed.client_email !== 'string' ||
    !parsed.client_email ||
    typeof parsed.private_key !== 'string' ||
    !parsed.private_key
  ) {
    throw new Error('ERR_STRATEGY_MISCONFIGURED')
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key }
}

function signAssertion(key: ServiceAccountKey, subject: string): string {
  const iat = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600
    })
  )
  const signingInput = `${header}.${claims}`
  try {
    const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key)
    return `${signingInput}.${base64url(signature)}`
  } catch {
    throw new Error('ERR_STRATEGY_MISCONFIGURED')
  }
}

async function requestJson(url: string, init: RequestInit): Promise<any> {
  let resp: Response
  try {
    resp = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new Error('ERR_PROVIDER_REQUEST_FAILED')
  }
  if (!resp.ok) {
    throw new Error('ERR_PROVIDER_REQUEST_FAILED')
  }
  try {
    return await resp.json()
  } catch {
    throw new Error('ERR_PROVIDER_REQUEST_FAILED')
  }
}

async function exchangeToken(assertion: string): Promise<string> {
  const body = await requestJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  })
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error('ERR_PROVIDER_REQUEST_FAILED')
  }
  return body.access_token
}

export async function fetchWorkspaceGroups(
  conf: Record<string, any>,
  email: string
): Promise<string[]> {
  const key = parseServiceAccountKey(conf.serviceAccountKey)
  const admin = typeof conf.delegatedAdminEmail === 'string' ? conf.delegatedAdminEmail.trim() : ''
  if (!admin) {
    throw new Error('ERR_STRATEGY_MISCONFIGURED')
  }

  const accessToken = await exchangeToken(signAssertion(key, admin))

  const names = new Set<string>()
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(GROUPS_URL)
    url.searchParams.set('userKey', email)
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }
    const body = await requestJson(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    })
    if (body?.groups !== undefined && !Array.isArray(body.groups)) {
      throw new Error('ERR_PROVIDER_REQUEST_FAILED')
    }
    for (const group of body?.groups ?? []) {
      const name = typeof group?.name === 'string' ? group.name.trim() : ''
      if (name) {
        names.add(name)
      }
    }
    if (typeof body?.nextPageToken !== 'string' || !body.nextPageToken) {
      return [...names]
    }
    pageToken = body.nextPageToken
  }
  throw new Error('ERR_PROVIDER_REQUEST_FAILED')
}
