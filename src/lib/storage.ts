import { randomBytes } from 'node:crypto'
import { extractBearerToken, getSupabaseAuthConfig, type AuthenticatedUser } from './auth.js'

type AuthorizationHeader = string | string[] | undefined

export type StoredBrief = {
  id: string
  title: string
  query: string
  identity_hint: string
  language: 'en' | 'vi'
  result: unknown
  report_text: string
  is_public: boolean
  public_slug: string | null
  created_at: string
  updated_at: string
}

export type StoredBriefSummary = Omit<StoredBrief, 'result' | 'report_text'>

export type WatchlistItem = {
  id: string
  name: string
  symbol: string | null
  official_domain: string | null
  blockchain: string | null
  contract_address: string | null
  last_brief_id: string | null
  created_at: string
  updated_at: string
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status = 503,
    readonly logMessage = message,
  ) {
    super(message)
  }
}

export async function saveBrief(
  authorization: AuthorizationHeader,
  user: AuthenticatedUser,
  input: {
    title: string
    query: string
    identityHint: string
    language: 'en' | 'vi'
    result: unknown
    reportText: string
  },
) {
  const rows = await userDatabaseRequest<StoredBrief[]>(authorization, 'briefs', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: user.id,
      title: input.title,
      query: input.query,
      identity_hint: input.identityHint,
      language: input.language,
      result: input.result,
      report_text: input.reportText,
    }),
  })
  return rows[0] ?? null
}

export function listBriefs(authorization: AuthorizationHeader, search = '') {
  const query = new URLSearchParams({
    select: 'id,title,query,identity_hint,language,is_public,public_slug,created_at,updated_at',
    order: 'created_at.desc',
    limit: '100',
  })
  if (search) query.set('or', `(title.ilike.*${escapePostgrestSearch(search)}*,query.ilike.*${escapePostgrestSearch(search)}*)`)
  return userDatabaseRequest<StoredBriefSummary[]>(authorization, `briefs?${query}`)
}

export async function getBrief(authorization: AuthorizationHeader, id: string) {
  const query = new URLSearchParams({
    select: 'id,title,query,identity_hint,language,result,report_text,is_public,public_slug,created_at,updated_at',
    id: `eq.${id}`,
    limit: '1',
  })
  const rows = await userDatabaseRequest<StoredBrief[]>(authorization, `briefs?${query}`)
  return rows[0] ?? null
}

export async function renameBrief(authorization: AuthorizationHeader, id: string, title: string) {
  const query = new URLSearchParams({ id: `eq.${id}`, select: '*' })
  const rows = await userDatabaseRequest<StoredBrief[]>(authorization, `briefs?${query}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ title, updated_at: new Date().toISOString() }),
  })
  return rows[0] ?? null
}

export async function deleteBrief(authorization: AuthorizationHeader, id: string) {
  const query = new URLSearchParams({ id: `eq.${id}` })
  await userDatabaseRequest(authorization, `briefs?${query}`, { method: 'DELETE' })
}

export async function shareBrief(authorization: AuthorizationHeader, id: string) {
  const publicSlug = randomBytes(18).toString('base64url')
  const query = new URLSearchParams({ id: `eq.${id}`, select: '*' })
  const rows = await userDatabaseRequest<StoredBrief[]>(authorization, `briefs?${query}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ is_public: true, public_slug: publicSlug, updated_at: new Date().toISOString() }),
  })
  return rows[0] ?? null
}

export async function getSharedBrief(slug: string) {
  const rows = await publicDatabaseRequest<Array<Pick<StoredBrief, 'id' | 'title' | 'language' | 'result' | 'report_text' | 'created_at' | 'updated_at'>>>(
    'rpc/get_shared_brief',
    { method: 'POST', body: JSON.stringify({ p_slug: slug }) },
  )
  return rows[0] ?? null
}

export function listWatchlist(authorization: AuthorizationHeader) {
  const query = new URLSearchParams({
    select: 'id,name,symbol,official_domain,blockchain,contract_address,last_brief_id,created_at,updated_at',
    order: 'created_at.desc',
    limit: '100',
  })
  return userDatabaseRequest<WatchlistItem[]>(authorization, `watchlist?${query}`)
}

export async function addWatchlistItem(
  authorization: AuthorizationHeader,
  user: AuthenticatedUser,
  input: Omit<WatchlistItem, 'id' | 'last_brief_id' | 'created_at' | 'updated_at'>,
) {
  const rows = await userDatabaseRequest<WatchlistItem[]>(authorization, 'watchlist', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ user_id: user.id, ...input }),
  })
  return rows[0] ?? null
}

export async function deleteWatchlistItem(authorization: AuthorizationHeader, id: string) {
  const query = new URLSearchParams({ id: `eq.${id}` })
  await userDatabaseRequest(authorization, `watchlist?${query}`, { method: 'DELETE' })
}

async function userDatabaseRequest<T = unknown>(authorization: AuthorizationHeader, path: string, init: RequestInit = {}) {
  const token = extractBearerToken(authorization)
  if (!token) throw new StorageError('Your session expired. Please sign in again.', 401, 'Missing bearer token for database request')
  return databaseRequest<T>(path, token, init)
}

async function publicDatabaseRequest<T = unknown>(path: string, init: RequestInit = {}) {
  return databaseRequest<T>(path, null, init)
}

async function databaseRequest<T>(path: string, token: string | null, init: RequestInit): Promise<T> {
  const config = getSupabaseAuthConfig()
  if (!config) throw new StorageError('Saved research is being configured. Please try again shortly.')

  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  headers.set('apikey', config.publishableKey)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body) headers.set('content-type', 'application/json')

  let response: Response
  try {
    response = await fetch(`${config.url}/rest/v1/${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(12_000),
    })
  } catch (error) {
    throw new StorageError('Saved research is temporarily unavailable.', 503, `Supabase REST request failed: ${safeError(error)}`)
  }

  if (!response.ok) {
    const status =
      response.status === 401 || response.status === 403
        ? 401
        : response.status === 409
          ? 409
          : response.status === 404
            ? 503
            : 502
    throw new StorageError(
      status === 401
        ? 'Your session expired. Please sign in again.'
        : status === 409
          ? 'This project is already in your watchlist.'
          : 'Saved research is temporarily unavailable.',
      status,
      `Supabase REST returned status ${response.status} for ${path.split('?')[0]}`,
    )
  }

  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function escapePostgrestSearch(value: string) {
  return value.replace(/[,*()]/g, ' ').trim().slice(0, 80)
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]') : 'unknown error'
}
