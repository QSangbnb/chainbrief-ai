export type SupabaseAuthConfig = {
  url: string
  publishableKey: string
}

export type AuthenticatedUser = {
  id: string
  email: string | null
}

export type AuthenticationResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; status: 401 | 503; message: string; logMessage: string }

type FetchLike = typeof fetch

export function getSupabaseAuthConfig(env: NodeJS.ProcessEnv = process.env): SupabaseAuthConfig | null {
  const rawUrl = env.SUPABASE_URL?.trim()
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim()
  if (!rawUrl || !publishableKey) return null

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return { url: url.origin, publishableKey }
}

export function extractBearerToken(authorization: string | string[] | undefined) {
  if (typeof authorization !== 'string') return null
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i)
  return match?.[1] ?? null
}

export async function authenticateSupabaseRequest(
  authorization: string | string[] | undefined,
  options: {
    env?: NodeJS.ProcessEnv
    fetchImpl?: FetchLike
  } = {},
): Promise<AuthenticationResult> {
  const config = getSupabaseAuthConfig(options.env)
  if (!config) {
    return {
      ok: false,
      status: 503,
      message: 'Sign-in is being configured. Please try again shortly.',
      logMessage: 'Supabase authentication is not configured',
    }
  }

  const token = extractBearerToken(authorization)
  if (!token) {
    return {
      ok: false,
      status: 401,
      message: 'Sign in with email or Google to use research.',
      logMessage: 'Missing bearer token',
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${config.url}/auth/v1/user`, {
      headers: {
        apikey: config.publishableKey,
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    return {
      ok: false,
      status: 503,
      message: 'The sign-in service is temporarily unavailable. Please try again.',
      logMessage: `Supabase user verification failed: ${safeErrorMessage(error)}`,
    }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: 401,
      message: 'Your session expired. Please sign in again.',
      logMessage: `Supabase rejected bearer token with status ${response.status}`,
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 503,
      message: 'The sign-in service is temporarily unavailable. Please try again.',
      logMessage: `Supabase user verification returned status ${response.status}`,
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return {
      ok: false,
      status: 503,
      message: 'The sign-in service returned an invalid response.',
      logMessage: 'Supabase user verification returned invalid JSON',
    }
  }

  if (!isVerifiedUser(payload)) {
    return {
      ok: false,
      status: 401,
      message: 'Your session could not be verified. Please sign in again.',
      logMessage: 'Supabase user response did not contain a valid user id',
    }
  }

  return {
    ok: true,
    user: {
      id: payload.id,
      email: typeof payload.email === 'string' ? payload.email : null,
    },
  }
}

function isVerifiedUser(value: unknown): value is { id: string; email?: unknown } {
  return Boolean(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && value.id)
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]') : 'unknown error'
}
