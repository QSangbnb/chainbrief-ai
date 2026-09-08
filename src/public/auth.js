const SESSION_STORAGE_KEY = 'chainbrief-auth-session'
const REFRESH_MARGIN_MS = 60_000
export const SESSION_INACTIVITY_MS = 3 * 24 * 60 * 60 * 1000
const ACTIVITY_WRITE_INTERVAL_MS = 60_000
const SESSION_EXPIRED_EVENT = 'chainbrief-session-expired'

export async function createAuthClient() {
  const response = await fetch('/api/auth/config', {
    headers: { accept: 'application/json' },
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(body.error || 'Sign-in is not configured.')

  const config = {
    url: normalizeUrl(body.supabaseUrl),
    publishableKey: requireString(body.supabasePublishableKey, 'Supabase publishable key'),
  }
  return new BrowserAuthClient(config)
}

class BrowserAuthClient {
  constructor(config) {
    this.config = config
    this.session = null
    this.user = null
    this.activityTrackingStarted = false
    this.lastActivityWriteAt = 0
  }

  async initialize() {
    const callback = consumeOAuthCallback()
    if (callback.error) throw new Error(callback.error)

    if (callback.session) this.setSession(callback.session)
    else this.session = readStoredSession()
    if (!this.session) return null
    if (isSessionInactive(this.session)) {
      this.clearSession()
      return null
    }

    const user = await this.getUser()
    if (!user) this.clearSession()
    else this.startActivityTracking()
    return user
  }

  async signInWithPassword(email, password) {
    const body = await this.authRequest('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    this.setSession(sessionFromPayload(body))
    this.user = requireUser(body.user)
    this.startActivityTracking()
    return this.user
  }

  async signUp(email, password) {
    const redirect = encodeURIComponent(window.location.origin)
    const body = await this.authRequest('/auth/v1/signup?redirect_to=' + redirect, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })

    const session = sessionFromPayload(body, true)
    if (session) {
      this.setSession(session)
      this.user = requireUser(body.user)
      this.startActivityTracking()
    }
    return { user: body.user || null, session }
  }

  signInWithGoogle() {
    const authorize = new URL(this.config.url + '/auth/v1/authorize')
    authorize.searchParams.set('provider', 'google')
    authorize.searchParams.set('redirect_to', window.location.origin)
    window.location.assign(authorize.toString())
  }

  async signOut() {
    if (this.session?.accessToken) {
      try {
        await fetch(this.config.url + '/auth/v1/logout', {
          method: 'POST',
          headers: this.headers(this.session.accessToken),
        })
      } catch {
        // Local sign-out must still succeed if Supabase is temporarily unavailable.
      }
    }
    this.clearSession()
  }

  async accessToken() {
    if (!this.session) return null
    if (isSessionInactive(this.session)) {
      this.expireInactiveSession()
      return null
    }
    if (this.session.expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
      const refreshed = await this.refreshSession()
      if (!refreshed) return null
    }
    this.markActivity()
    return this.session.accessToken
  }

  async getUser() {
    let token = await this.accessToken()
    if (!token) return null

    let response = await fetch(this.config.url + '/auth/v1/user', {
      headers: this.headers(token),
    })
    if (response.status === 401) {
      const refreshed = await this.refreshSession()
      if (!refreshed) return null
      token = this.session.accessToken
      response = await fetch(this.config.url + '/auth/v1/user', {
        headers: this.headers(token),
      })
    }
    if (!response.ok) return null

    const body = await readJson(response)
    this.user = requireUser(body)
    return this.user
  }

  clearSession() {
    this.session = null
    this.user = null
    localStorage.removeItem(SESSION_STORAGE_KEY)
  }

  async refreshSession() {
    if (!this.session?.refreshToken) {
      this.clearSession()
      return false
    }

    try {
      const body = await this.authRequest('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: this.session.refreshToken }),
      })
      this.setSession(sessionFromPayload(body))
      if (body.user) this.user = requireUser(body.user)
      return true
    } catch {
      this.clearSession()
      return false
    }
  }

  setSession(session) {
    this.session = {
      ...session,
      lastActiveAt: Number.isFinite(session.lastActiveAt) ? session.lastActiveAt : Date.now(),
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(this.session))
  }

  startActivityTracking() {
    if (this.activityTrackingStarted) return
    this.activityTrackingStarted = true
    const markActivity = () => this.markActivity()
    window.addEventListener('pointerdown', markActivity, { passive: true })
    window.addEventListener('keydown', markActivity)
    window.addEventListener('touchstart', markActivity, { passive: true })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.markActivity()
    })
  }

  markActivity() {
    if (!this.session) return
    const now = Date.now()
    if (isSessionInactive(this.session, now)) {
      this.expireInactiveSession()
      return
    }
    if (now - this.lastActivityWriteAt < ACTIVITY_WRITE_INTERVAL_MS) return
    this.lastActivityWriteAt = now
    this.session.lastActiveAt = now
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(this.session))
  }

  expireInactiveSession() {
    this.clearSession()
    window.dispatchEvent(new window.Event(SESSION_EXPIRED_EVENT))
  }

  headers(accessToken) {
    const headers = {
      accept: 'application/json',
      apikey: this.config.publishableKey,
      'content-type': 'application/json',
    }
    if (accessToken) headers.authorization = 'Bearer ' + accessToken
    return headers
  }

  async authRequest(path, options) {
    const response = await fetch(this.config.url + path, {
      ...options,
      headers: {
        ...this.headers(),
        ...(options.headers || {}),
      },
    })
    const body = await readJson(response)
    if (!response.ok) {
      throw new Error(body.error_description || body.msg || body.message || 'Authentication failed.')
    }
    return body
  }
}

function consumeOAuthCallback() {
  const params = new URLSearchParams(window.location.hash.slice(1))
  if (!params.size) return { session: null, error: '' }

  const error = params.get('error_description') || params.get('error') || ''
  const accessToken = params.get('access_token')
  const refreshToken = params.get('refresh_token')
  const expiresIn = Number(params.get('expires_in') || 3600)
  window.history.replaceState({}, document.title, window.location.pathname + window.location.search)

  if (error) return { session: null, error }
  if (!accessToken || !refreshToken) return { session: null, error: '' }
  return {
    error: '',
    session: {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + Math.max(expiresIn, 60) * 1000,
      lastActiveAt: Date.now(),
    },
  }
}

function sessionFromPayload(body, optional = false) {
  const accessToken = body.access_token
  const refreshToken = body.refresh_token
  if (optional && (!accessToken || !refreshToken)) return null
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new Error('The sign-in service did not return a valid session.')
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Math.max(Number(body.expires_in || 3600), 60) * 1000,
    lastActiveAt: Date.now(),
  }
}

function readStoredSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || 'null')
    if (
      parsed &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        lastActiveAt: Number.isFinite(parsed.lastActiveAt) ? parsed.lastActiveAt : Date.now(),
      }
    }
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEY)
  }
  return null
}

export function isSessionInactive(session, now = Date.now()) {
  return !Number.isFinite(session?.lastActiveAt) || now - session.lastActiveAt >= SESSION_INACTIVITY_MS
}

function requireUser(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') {
    throw new Error('The sign-in service did not return a valid user.')
  }
  return {
    id: value.id,
    email: typeof value.email === 'string' ? value.email : '',
  }
}

function normalizeUrl(value) {
  const url = new URL(requireString(value, 'Supabase URL'))
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Supabase URL is invalid.')
  return url.origin
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is missing.')
  return value.trim()
}

async function readJson(response) {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The sign-in service returned an invalid response.')
  }
}
