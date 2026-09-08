import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { config } from 'dotenv'
import { z } from 'zod'
import { authenticateSupabaseRequest, getSupabaseAuthConfig } from './lib/auth.js'
import {
  DisambiguationCandidate,
  detectIdentityConflict,
  extractVerifiedIdentityFromText,
  hasIdentityConstraints,
  identityPrompt,
  IdentityVerified,
  mergeVerifiedIdentity,
  normalizeForMatching,
  parseIdentityHint,
  type DisambiguationCandidateData,
  type IdentityConstraints,
} from './lib/identity.js'
import { normalizeSocialPostText, sanitizeSocialDraft, SocialDraftRequest, socialPrompt, type SocialChannel } from './lib/social.js'

config({ path: ['.env.local', '.env'], quiet: true })

type Language = 'en' | 'vi'
const PORT = Number(process.env.PORT ?? 5173)
const PUBLIC_DIR = join(process.cwd(), 'src', 'public')
const REDACTED_SECRET_PATTERN = /(?:sk-or-v1-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/g
const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const MAX_REQUEST_BYTES = 64 * 1024
const PAID_REQUEST_TIMEOUT_MS = 120_000
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 8
const PAID_CONCURRENCY_MAX = Number(process.env.PAID_CONCURRENCY_MAX ?? 2)
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()
let activePaidRequests = 0

const ResearchRequest = z.object({
  query: z.string().trim().min(2).max(500),
  identityHint: z.string().trim().max(500).optional().default(''),
  language: z.enum(['en', 'vi']),
})

const SourceLink = z.object({
  title: z.string().default('Source'),
  url: z.url(),
})

const ResearchReport = z.object({
  identityVerified: IdentityVerified.prefault({}),
  executiveSummary: z.array(z.string()).default([]),
  keyFacts: z.array(z.string()).default([]),
  technologyAndUseCase: z.array(z.string()).default([]),
  tokenInformation: z.array(z.string()).default([]),
  positiveSignals: z.array(z.string()).default([]),
  risksAndUnverifiableClaims: z.array(z.string()).default([]),
  sourceLinks: z.array(SourceLink).default([]),
  notFinancialAdvice: z.string().default('This report is for research only and is not financial advice.'),
})

const ResearchEnvelope = z.object({
  responseType: z.enum(['report', 'disambiguation']).default('report'),
  identityVerified: IdentityVerified.prefault({}),
  disambiguationCandidates: z.array(DisambiguationCandidate).default([]),
  clarificationQuestion: z.string().default(''),
  report: ResearchReport.optional(),
})

type ResearchReportData = z.infer<typeof ResearchReport>
type ReportBodyData = Omit<ResearchReportData, 'identityVerified'>
type SourceLinkData = z.infer<typeof SourceLink>
type ResearchResult =
  | { mode: 'structured'; identity: z.infer<typeof IdentityVerified>; report: ReportBodyData; text: string }
  | { mode: 'fallback'; identity: z.infer<typeof IdentityVerified>; markdown: string; sourceLinks: SourceLinkData[]; text: string }
  | { mode: 'disambiguation'; candidates: DisambiguationCandidateData[]; question: string; text: string }

const SocialPost = z.object({
  post: z.string().trim().min(20).max(2800),
})

class PublicError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly logMessage = message,
  ) {
    super(message)
  }
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: 'Bad request.' })
      return
    }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'POST' && url.pathname === '/api/research') {
      await handlePaidEndpoint(req, res, 'research', () => handleResearch(req, res))
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/social') {
      await handlePaidEndpoint(req, res, 'social', () => handleSocial(req, res))
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      await handleHealth(res)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/config') {
      handleAuthConfig(res)
      return
    }

    if (req.method === 'GET') {
      await serveStatic(url.pathname, res)
      return
    }

    sendJson(res, 405, { error: 'Method not allowed.' })
  } catch (error) {
    const safeError = toPublicError(error)
    logSafe('error', safeError.status, safeError.logMessage)
    sendJson(res, safeError.status, { error: safeError.message })
  }
})

server.keepAliveTimeout = 120_000
server.headersTimeout = 125_000

server.listen(PORT, () => {
  console.log(`ChainBrief AI is running at http://localhost:${PORT}`)
})

async function handleResearch(req: IncomingMessage, res: ServerResponse) {
  const payload = ResearchRequest.safeParse(await readJson(req, MAX_REQUEST_BYTES))
  if (!payload.success) {
    sendJson(res, 400, { error: 'Enter at least 2 characters and choose a supported language.' })
    return
  }

  const urlValidation = validateUserSuppliedUrls(`${payload.data.query}\n${payload.data.identityHint}`)
  if (!urlValidation.ok) {
    sendJson(res, 400, { error: urlValidation.message })
    return
  }

  const result = await runResearch(payload.data.query, payload.data.identityHint, payload.data.language)
  sendJson(res, 200, { result })
}

async function handleSocial(req: IncomingMessage, res: ServerResponse) {
  const payload = SocialDraftRequest.safeParse(await readJson(req, MAX_REQUEST_BYTES))
  if (!payload.success) {
    sendJson(res, 400, { error: 'Generate a report first, then choose a social channel.' })
    return
  }

  const result = await createSocialPost(payload.data.identity, payload.data.report, payload.data.language, payload.data.channel)
  sendJson(res, 200, {
    approvalRequired: true,
    draft: result.draft,
    sanitized: result.sanitized,
    notice: socialNotice(payload.data.language, result.sanitized),
  })
}

async function handlePaidEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: 'research' | 'social',
  handler: () => Promise<void>,
) {
  const authentication = await authenticateSupabaseRequest(req.headers.authorization)
  if (!authentication.ok) {
    logSafe('warning', authentication.status, `authentication_denied endpoint=/${endpoint} reason=${authentication.logMessage}`)
    sendJson(res, authentication.status, { error: authentication.message })
    return
  }

  if (!checkDemoAccessCode(req)) {
    logSafe('warning', 401, `paid_endpoint_access_denied endpoint=/${endpoint}`)
    sendJson(res, 401, { error: 'Access code required for this public demo.' })
    return
  }

  if (!checkRateLimit(req, endpoint)) {
    logSafe('warning', 429, `paid_endpoint_rate_limited endpoint=/${endpoint}`)
    sendJson(res, 429, { error: 'Too many requests. Please wait before trying again.' })
    return
  }

  if (activePaidRequests >= PAID_CONCURRENCY_MAX) {
    logSafe('warning', 429, `paid_endpoint_concurrency_limited endpoint=/${endpoint}`)
    sendJson(res, 429, { error: 'The service is busy. Please wait for the current request to finish.' })
    return
  }

  activePaidRequests += 1
  try {
    await handler()
  } finally {
    activePaidRequests -= 1
  }
}

async function handleHealth(res: ServerResponse) {
  const key = process.env.OPENROUTER_API_KEY ?? ''
  const authConfig = getSupabaseAuthConfig()
  const connectivity = await checkOpenRouterConnectivity()
  sendJson(res, 200, {
    server: {
      ok: true,
      port: PORT,
    },
    configuration: {
      envLoaded: Boolean(key),
      openrouterApiKeyConfigured: Boolean(key),
      authenticationRequired: true,
      supabaseConfigured: Boolean(authConfig),
      demoAccessCodeRequired: Boolean(process.env.DEMO_ACCESS_CODE),
      model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5',
    },
    openrouter: connectivity,
  })
}

function handleAuthConfig(res: ServerResponse) {
  const authConfig = getSupabaseAuthConfig()
  if (!authConfig) {
    sendJson(res, 503, { error: 'Sign-in is being configured. Please try again shortly.' })
    return
  }

  sendJson(res, 200, {
    supabaseUrl: authConfig.url,
    supabasePublishableKey: authConfig.publishableKey,
  })
}

async function runResearch(query: string, identityHint: string, language: Language): Promise<ResearchResult> {
  const { DEFAULT_MODEL, openrouterFetch } = await import('./lib/openrouter.js').catch((error: unknown) => {
    throw new PublicError(
      'The research service is not available. Restart the server and try again.',
      503,
      `OpenRouter client import failed: ${errorMessage(error)}`,
    )
  })
  const label = language === 'vi' ? 'Vietnamese' : 'English'
  const identity = parseIdentityHint(identityHint)
  const officialOnly = wantsOfficialSources(query)
  const hardIdentityPrompt = identityPrompt(identity, officialOnly)
  const headings =
    language === 'vi'
      ? [
          'Tóm tắt điều hành',
          'Thông tin chính',
          'Công nghệ và trường hợp sử dụng',
          'Thông tin token',
          'Tín hiệu tích cực',
          'Rủi ro và tuyên bố chưa thể xác minh',
          'Nguồn',
          'Lưu ý không phải lời khuyên tài chính',
        ]
      : [
          'Executive summary',
          'Key facts',
          'Technology and use case',
          'Token information',
          'Positive signals',
          'Risks and unverifiable claims',
          'Sources',
          'Not financial advice',
        ]
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PAID_REQUEST_TIMEOUT_MS)
  const res = await openrouterFetch('/chat/completions', {
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            `You are ChainBrief AI, a cautious bilingual crypto research analyst. Write the final answer entirely in ${label}. ` +
            'First resolve the exact crypto entity. If the user gave an official URL, contract address, or blockchain, it is a hard identity constraint. ' +
            'Never substitute another project with the same or similar name. ' +
            'If only a project/token name is supplied and multiple plausible crypto entities exist, do not choose one. Return a disambiguation response listing candidate names, chains, contracts when available, and official domains when available, then ask the user for the correct URL, contract, or chain. ' +
            'Output the final report immediately. Never describe your research process, searches, tool use, reasoning steps, or what you will do next. ' +
            'Do not include phrases like "I will research", "let me search", "now I have enough information", or similar progress narration. ' +
            'Use web search for current facts. Do not provide investment advice. Do not claim certainty when evidence is weak. ' +
            'If reliable information is unavailable, say it could not be verified. ' +
            'Every factual claim should either include a visible source URL nearby or be framed as unverified. ' +
            'Every source link must be a URL you actually used. Never invent citations. ' +
            (officialOnly
              ? 'The user requested official sources only. Use only the supplied official domain when present, its documentation, repositories linked from it, and an authoritative blockchain explorer. Do not present secondary-source claims as verified facts. '
              : 'Prefer primary sources, project docs, reputable market data, audits, and major news sources. ') +
            'Completed reports must include verified identity fields for name, symbol, officialDomain, blockchain, chainId, and contractAddress when verified. Leave unavailable identity fields null rather than guessing. ' +
            `Use these exact section headings only, translated exactly as provided when possible: ${headings.join('; ')}.` +
            (hardIdentityPrompt ? `\n\n${hardIdentityPrompt}` : ''),
        },
        {
          role: 'user',
          content:
            `Research this crypto token, project, contract address, or question: ${query}\n\n` +
            (hardIdentityPrompt ? `${hardIdentityPrompt}\n\n` : '') +
            `Return only the final report in ${label}. ` +
            'No preamble, no search narration, no tool-progress messages. Include a clearly labeled Sources section with only real URLs from your research. ' +
            'If a claim cannot be verified from available sources, place it in risks/unverifiable claims.',
        },
      ],
      tools: [{ type: 'openrouter:web_search' }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chainbrief_research_response', strict: true, schema: z.toJSONSchema(ResearchEnvelope) },
      },
      provider: { require_parameters: true },
    }),
  })
    .catch((error: unknown) => {
      throw openRouterPublicError(error, 'research', '/chat/completions')
    })
    .finally(() => clearTimeout(timeout))

  if (!res.ok) {
    const bodyMessage = await sanitizeResponseText(res)
    const classified = classifyOpenRouterStatus(res.status)
    throw new PublicError(
      openRouterStatusMessage(res.status),
      classified.status,
      `OpenRouter research failed endpoint=/chat/completions upstream_status=${res.status} category=${classified.category} message=${bodyMessage}`,
    )
  }
  const body = (await res.json()) as ChatCompletionBody
  const message = body.choices[0]?.message
  const content = extractMessageText(message?.content)
  if (!content) {
    throw new PublicError('OpenRouter returned an empty research response. Try a more specific query.', 502)
  }

  const sourceLinks = collectSourceLinks(content, message)
  const result = buildResearchResult(cleanFinalReport(content, language), sourceLinks, language, identity)
  return resolveIdentityConflicts(result, identity, language)
}

async function createSocialPost(
  identity: z.infer<typeof IdentityVerified>,
  report: string,
  language: Language,
  channel: SocialChannel,
) {
  const { DEFAULT_MODEL, openrouter } = await import('./lib/openrouter.js').catch((error: unknown) => {
    throw new PublicError(
      'The drafting service is not available. Restart the server and try again.',
      503,
      `OpenRouter client import failed: ${errorMessage(error)}`,
    )
  })
  const completion = await openrouter.chat.completions
    .create({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: socialPrompt({ identity, report, language, channel }),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chainbrief_social_post', strict: true, schema: z.toJSONSchema(SocialPost) },
      },
      // @ts-expect-error OpenRouter extension, not in the OpenAI SDK types.
      provider: { require_parameters: true },
    },
    {
      timeout: PAID_REQUEST_TIMEOUT_MS,
    })
    .catch((error: unknown) => {
      throw openRouterPublicError(error, 'social', '/chat/completions')
    })

  const content = completion.choices[0]?.message.content
  if (!content) {
    const fallback = sanitizeSocialDraft({ draft: '', identity, report, language, channel })
    return { draft: fallback.draft, sanitized: true }
  }

  const draft = normalizeSocialPostText(content)
  const parsedPost = SocialPost.safeParse({ post: draft })
  if (!parsedPost.success) logSafe('warning', 200, 'social_normalized_text_validation_fallback')

  const sanitized = sanitizeSocialDraft({ draft: parsedPost.success ? parsedPost.data.post : draft, identity, report, language, channel })
  if (sanitized.removedReasons.length > 0) {
    logSafe('warning', 200, `social_draft_sanitized: ${sanitized.removedReasons.join(',')}`)
  }
  if (sanitized.usedFallback) logSafe('warning', 200, 'social_draft_fallback_used')

  return { draft: sanitized.draft, sanitized: sanitized.changed || sanitized.usedFallback }
}

async function readJson(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > maxBytes) {
      throw new PublicError('Request body is too large.', 413, `Request body exceeded ${maxBytes} bytes`)
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const cleanPath = pathname === '/' ? '/index.html' : pathname
  const normalized = normalize(cleanPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = join(PUBLIC_DIR, normalized)

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'Forbidden.' })
    return
  }

  try {
    await readFile(filePath)
    res.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
  } catch {
    sendJson(res, 404, { error: 'Not found.' })
  }
}

async function sanitizeResponseText(res: Response) {
  const text = redactSecrets(await res.text())
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message ?? res.statusText
  } catch {
    return res.statusText || 'OpenRouter error'
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function socialNotice(language: Language, sanitized: boolean) {
  if (language === 'vi') {
    return sanitized
      ? 'Bản nháp đã được làm sạch để loại bỏ thông tin chưa được hỗ trợ. Cần phê duyệt thủ công trước khi sao chép. Không có nội dung nào được đăng.'
      : 'Cần phê duyệt thủ công trước khi dùng bản nháp làm bài đăng cuối cùng. Không có nội dung nào được đăng.'
  }

  return sanitized
    ? 'The draft was cleaned to remove unsupported information. Human approval is required before copying. Nothing has been published.'
    : 'Human approval is required before this draft is used as the final social post. Nothing has been published.'
}

function checkDemoAccessCode(req: IncomingMessage) {
  const expected = process.env.DEMO_ACCESS_CODE
  if (!expected) return true
  const provided = req.headers['x-demo-access-code']
  return typeof provided === 'string' && provided === expected
}

function checkRateLimit(req: IncomingMessage, endpoint: 'research' | 'social') {
  const now = Date.now()
  const key = `${clientAddress(req)}:${endpoint}`
  const existing = rateLimitBuckets.get(key)

  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  if (existing.count >= RATE_LIMIT_MAX) return false
  existing.count += 1
  return true
}

function clientAddress(req: IncomingMessage) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]?.trim() ?? 'unknown'
  return req.socket.remoteAddress ?? 'unknown'
}

function validateUserSuppliedUrls(text: string): { ok: true } | { ok: false; message: string } {
  const urlPattern = /\b(?:[a-z][a-z0-9+.-]*:\/\/)[^\s<>)\]}"]+/gi
  for (const rawUrl of text.match(urlPattern) ?? []) {
    const url = parseSafeUrl(rawUrl)
    if (!url) return { ok: false, message: 'Only valid http and https URLs are supported.' }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, message: 'Only http and https URLs are supported.' }
    }
    if (isBlockedHost(url.hostname)) {
      return { ok: false, message: 'Localhost, private-network, and loopback URLs are not allowed.' }
    }
  }

  return { ok: true }
}

function parseSafeUrl(rawUrl: string) {
  try {
    return new URL(rawUrl.replace(/[.,;:!?]+$/, ''))
  } catch {
    return null
  }
}

function isBlockedHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true

  const ipVersion = isIP(host)
  if (ipVersion === 4) return isBlockedIpv4(host)
  if (ipVersion === 6) return isBlockedIpv6(host)
  return false
}

function isBlockedIpv4(host: string) {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function isBlockedIpv6(host: string) {
  return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
}

async function checkOpenRouterConnectivity() {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(OPENROUTER_MODELS_ENDPOINT, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    return {
      ok: res.ok,
      endpoint: '/api/v1/models',
      status: res.status,
      category: res.ok ? 'ok' : classifyOpenRouterStatus(res.status).category,
      latencyMs: Date.now() - started,
    }
  } catch (error) {
    const classified = classifyOpenRouterError(error)
    return {
      ok: false,
      endpoint: '/api/v1/models',
      status: null,
      category: classified.category,
      errorClass: classified.errorClass,
      causeClass: classified.causeClass,
      causeCode: classified.causeCode,
      message: classified.safeMessage,
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function openRouterPublicError(error: unknown, operation: 'research' | 'social', endpoint: string) {
  const status = numberProperty(error, 'status')
  if (status) {
    const classified = classifyOpenRouterStatus(status)
    return new PublicError(
      openRouterStatusMessage(status),
      classified.status,
      `OpenRouter ${operation} failed endpoint=${endpoint} upstream_status=${status} category=${classified.category} message=${errorMessage(error)}`,
    )
  }

  const classified = classifyOpenRouterError(error)
  return new PublicError(
    classified.safeMessage,
    classified.status,
    `OpenRouter ${operation} network error endpoint=${endpoint} error_class=${classified.errorClass} cause_class=${classified.causeClass ?? 'none'} cause_code=${classified.causeCode ?? 'none'} message=${classified.logMessage}`,
  )
}

function classifyOpenRouterStatus(status: number) {
  if (status === 401) return { status: 401, category: 'invalid_key' }
  if (status === 402) return { status: 402, category: 'insufficient_credit' }
  if (status === 429) return { status: 429, category: 'rate_limited' }
  if (status >= 500) return { status: 502, category: 'openrouter_or_provider_outage' }
  return { status: 502, category: 'openrouter_http_error' }
}

function openRouterStatusMessage(status: number) {
  if (status === 401) return 'OpenRouter rejected the configured API key. Check the key without exposing it.'
  if (status === 402) return 'OpenRouter reported insufficient credit for this request.'
  if (status === 429) return 'OpenRouter rate-limited the request. Wait before retrying.'
  if (status >= 500) return 'OpenRouter or the selected provider is temporarily unavailable.'
  return 'OpenRouter returned an unexpected error for this request.'
}

function classifyOpenRouterError(error: unknown) {
  const errorClass = error instanceof Error ? error.constructor.name : typeof error
  const cause = error instanceof Error ? error.cause : undefined
  const causeClass = cause && typeof cause === 'object' ? cause.constructor.name : undefined
  const causeCode = stringProperty(cause, 'code')
  const message = errorMessage(error)
  const causeMessage = cause instanceof Error ? errorMessage(cause) : ''
  const combined = `${message} ${causeMessage} ${causeCode ?? ''}`.toLowerCase()

  if (combined.includes('abort') || combined.includes('timeout')) {
    return {
      status: 503,
      category: 'timeout',
      safeMessage: 'The server timed out while connecting to OpenRouter.',
      errorClass,
      causeClass,
      causeCode,
      logMessage: message,
    }
  }

  if (
    combined.includes('eacces') ||
    combined.includes('enotfound') ||
    combined.includes('econnrefused') ||
    combined.includes('econnreset') ||
    combined.includes('fetch failed') ||
    combined.includes('tls') ||
    combined.includes('certificate')
  ) {
    return {
      status: 503,
      category: 'dns_tls_or_connection_failure',
      safeMessage: 'The server could not connect to OpenRouter because of a DNS, TLS, timeout, or network access failure.',
      errorClass,
      causeClass,
      causeCode,
      logMessage: message,
    }
  }

  return {
    status: 503,
    category: 'connection_failure',
    safeMessage: 'The server could not reach OpenRouter.',
    errorClass,
    causeClass,
    causeCode,
    logMessage: message,
  }
}

function toPublicError(error: unknown) {
  if (error instanceof PublicError) return error
  if (error instanceof SyntaxError) {
    return new PublicError('The request body is not valid JSON.', 400, `Invalid JSON request: ${error.message}`)
  }

  return new PublicError(
    'The server could not complete the request. Check the server logs for a redacted diagnostic message.',
    500,
    `Unhandled request error: ${errorMessage(error)}`,
  )
}

function errorMessage(error: unknown) {
  return redactSecrets(error instanceof Error ? error.message : String(error))
}

function redactSecrets(value: string) {
  return value.replace(REDACTED_SECRET_PATTERN, '[redacted]')
}

function logSafe(type: 'error' | 'warning', status: number, message: string) {
  const line = `type=${type} status=${status} message=${redactSecrets(message)}`
  if (type === 'error') console.error(line)
  else console.warn(line)
}

function numberProperty(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' ? candidate : undefined
}

function stringProperty(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

type ChatCompletionBody = {
  choices: Array<{
    message: {
      content: unknown
      annotations?: unknown
    }
  }>
}

function buildResearchResult(
  content: string,
  sourceLinks: SourceLinkData[],
  language: Language,
  constraints: IdentityConstraints,
): ResearchResult {
  const parsedJson = parseStructuredCandidate(content)
  if (parsedJson) {
    const envelope = ResearchEnvelope.safeParse(parsedJson)
    if (envelope.success) {
      if (envelope.data.responseType === 'disambiguation') {
        const question =
          envelope.data.clarificationQuestion ||
          (language === 'vi'
            ? 'Có nhiều thực thể trùng tên. Vui lòng cung cấp URL chính thức, địa chỉ hợp đồng, hoặc blockchain chính xác.'
            : 'Multiple entities share this name. Please provide the correct official URL, contract address, or blockchain.')
        return {
          mode: 'disambiguation',
          candidates: envelope.data.disambiguationCandidates,
          question,
          text: disambiguationToText(envelope.data.disambiguationCandidates, question),
        }
      }

      if (envelope.data.report) {
        const mergedIdentity = mergeVerifiedIdentity(envelope.data.report.identityVerified, constraints)
        const report = normalizeStructuredReport(
          {
            ...envelope.data.report,
            identityVerified: mergedIdentity,
          },
          sourceLinks,
        )
        return { mode: 'structured', identity: mergedIdentity, report: stripReportIdentity(report), text: structuredReportToText(report, language) }
      }
    }

    const validated = ResearchReport.safeParse(parsedJson)
    if (validated.success) {
      const mergedIdentity = mergeVerifiedIdentity(validated.data.identityVerified, constraints)
      const report = normalizeStructuredReport(
        { ...validated.data, identityVerified: mergedIdentity },
        sourceLinks,
      )
      return { mode: 'structured', identity: mergedIdentity, report: stripReportIdentity(report), text: structuredReportToText(report, language) }
    }

    logSafe('warning', 200, 'research_json_validation_fallback')
  } else {
    logSafe('warning', 200, 'research_json_parse_fallback')
  }

  const parsedIdentity = mergeVerifiedIdentity(
    extractVerifiedIdentityFromText(
      content,
      sourceLinks.map((source) => source.url),
    ),
    constraints,
  )
  const markdown = ensureResearchNotice(stripIdentitySections(stripSourceSections(content)), language)
  return {
    mode: 'fallback',
    identity: parsedIdentity,
    markdown,
    sourceLinks,
    text: fallbackReportToText(parsedIdentity, markdown, sourceLinks, language),
  }
}

function parseStructuredCandidate(content: string): unknown | undefined {
  for (const candidate of jsonCandidates(content)) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next candidate, then fall back to grounded text.
    }
  }

  return undefined
}

function jsonCandidates(content: string) {
  const candidates = [content.trim()]
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(content.slice(start, end + 1))

  return [...new Set(candidates)].filter(Boolean)
}

function normalizeStructuredReport(report: ResearchReportData, sourceLinks: SourceLinkData[]): ResearchReportData {
  const allowedUrls = new Set(sourceLinks.map((source) => source.url))
  const citedLinks = report.sourceLinks.filter((source) => allowedUrls.has(source.url))
  const mergedLinks = [...citedLinks]

  for (const source of sourceLinks) {
    if (!mergedLinks.some((item) => item.url === source.url)) mergedLinks.push(source)
  }

  return {
    identityVerified: report.identityVerified,
    executiveSummary: report.executiveSummary,
    keyFacts: report.keyFacts,
    technologyAndUseCase: report.technologyAndUseCase,
    tokenInformation: report.tokenInformation,
    positiveSignals: report.positiveSignals,
    risksAndUnverifiableClaims: report.risksAndUnverifiableClaims,
    sourceLinks: mergedLinks.length ? mergedLinks : report.sourceLinks,
    notFinancialAdvice: report.notFinancialAdvice,
  }
}

function stripReportIdentity(report: ResearchReportData): ReportBodyData {
  return {
    executiveSummary: report.executiveSummary,
    keyFacts: report.keyFacts,
    technologyAndUseCase: report.technologyAndUseCase,
    tokenInformation: report.tokenInformation,
    positiveSignals: report.positiveSignals,
    risksAndUnverifiableClaims: report.risksAndUnverifiableClaims,
    sourceLinks: report.sourceLinks,
    notFinancialAdvice: report.notFinancialAdvice,
  }
}

function resolveIdentityConflicts(result: ResearchResult, constraints: IdentityConstraints, language: Language): ResearchResult {
  if (!hasIdentityConstraints(constraints) || result.mode === 'disambiguation') return result

  const sourceUrls = result.mode === 'structured' ? result.report.sourceLinks.map((source) => source.url) : result.sourceLinks.map((source) => source.url)
  const conflict = detectIdentityConflict({
    text: result.text,
    sourceUrls,
    identity: result.identity,
    constraints,
  })

  if (!conflict) return result

  logSafe('warning', 200, `identity_conflict_disambiguation: ${conflict}`)
  const question =
    language === 'vi'
      ? 'Thông tin nhận dạng trong kết quả nghiên cứu mâu thuẫn với URL, blockchain, hoặc hợp đồng bạn đã cung cấp. Vui lòng kiểm tra lại URL chính thức, địa chỉ hợp đồng, hoặc blockchain trước khi tạo báo cáo.'
      : 'The researched identity conflicts with the official URL, blockchain, or contract you supplied. Please confirm the correct official URL, contract address, or blockchain before generating a report.'

  return {
    mode: 'disambiguation',
    candidates: [
      {
        name: result.identity.name ?? 'not verified',
        blockchain: result.identity.blockchain ?? 'not verified',
        contractAddress: result.identity.contractAddress,
        domain: result.identity.officialDomain ?? 'not verified',
      },
    ],
    question,
    text: disambiguationToText(
      [
        {
          name: result.identity.name ?? 'not verified',
          blockchain: result.identity.blockchain ?? 'not verified',
          contractAddress: result.identity.contractAddress,
          domain: result.identity.officialDomain ?? 'not verified',
        },
      ],
      question,
    ),
  }
}

function disambiguationToText(candidates: DisambiguationCandidateData[], question: string) {
  const rows = candidates.map(
    (candidate) =>
      `- ${candidate.name} | chain: ${candidate.blockchain} | contract: ${candidate.contractAddress ?? 'not verified'} | domain: ${candidate.domain}`,
  )
  return `${question}\n${rows.join('\n')}`
}

function stripSourceSections(content: string) {
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  let inSources = false

  for (const line of lines) {
    const normalized = normalizeForMatching(line.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/:$/, '').trim())
    if (['sources', 'source links', 'nguon', 'nguon tham khao'].includes(normalized)) {
      inSources = true
      continue
    }

    if (inSources && /^#{1,6}\s+/.test(line)) inSources = false
    if (!inSources) kept.push(line)
  }

  return kept.join('\n').trim()
}

function stripIdentitySections(content: string) {
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  let inIdentity = false

  for (const line of lines) {
    const normalized = normalizeForMatching(line.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/:$/, '').trim())
    if (
      [
        'identity verified',
        'verified identity',
        'danh tinh da xac minh',
        'thong tin dinh danh',
        'xac minh danh tinh',
      ].includes(normalized)
    ) {
      inIdentity = true
      continue
    }

    if (inIdentity && /^#{1,6}\s+/.test(line)) inIdentity = false
    if (!inIdentity) kept.push(line)
  }

  return kept.join('\n').trim()
}

function collectSourceLinks(content: string, message: ChatCompletionBody['choices'][number]['message'] | undefined) {
  const links = new Map<string, SourceLinkData>()

  for (const url of extractUrls(content)) links.set(url, { title: domainTitle(url), url })

  for (const source of extractAnnotationLinks(message?.annotations)) {
    if (!links.has(source.url)) links.set(source.url, source)
  }

  return [...links.values()]
}

function extractAnnotationLinks(annotations: unknown): SourceLinkData[] {
  if (!Array.isArray(annotations)) return []

  const links: SourceLinkData[] = []
  for (const annotation of annotations) {
    const parsed = z
      .object({
        url_citation: z
          .object({
            url: z.url(),
            title: z.string().optional(),
          })
          .optional(),
      })
      .passthrough()
      .safeParse(annotation)

    const citation = parsed.success ? parsed.data.url_citation : undefined
    if (citation) links.push({ title: citation.title ?? domainTitle(citation.url), url: citation.url })
  }

  return links
}

function extractUrls(text: string) {
  const urls = text.match(/https?:\/\/[^\s<>)\]}"]+/g) ?? []
  return urls.map((url) => url.replace(/[.,;:!?]+$/, '')).filter((url) => SourceLink.shape.url.safeParse(url).success)
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      const parsed = z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough().safeParse(part)
      return parsed.success ? parsed.data.text ?? '' : ''
    })
    .join('\n')
    .trim()
}

function cleanFinalReport(content: string, language: Language) {
  const withoutFences = content.replace(/```(?:markdown|md)?\s*([\s\S]*?)```/gi, '$1').trim()
  const lines = withoutFences.split(/\r?\n/)
  const cleaned: string[] = []
  let started = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (!started && isNarrationLine(line, language)) continue
    if (!started && isReportStart(line, language)) started = true
    if (started || !isNarrationLine(line, language)) cleaned.push(rawLine)
  }

  return cleaned.join('\n').trim()
}

function isNarrationLine(line: string, language: Language) {
  const englishNarration =
    /^(i('|’)ll|i will|let me|i need to|i found|now i|based on my search|after searching|i have enough|here('|’)s|here is)/i
  const vietnameseNarration =
    /^(toi se|toi can|toi da|bay gio|dua tren ket qua tim kiem|sau khi tim kiem|duoi day la|sau day la)/i
  const normalized = normalizeForMatching(line)
  return englishNarration.test(line) || (language === 'vi' && vietnameseNarration.test(normalized))
}

function isReportStart(line: string, language: Language) {
  const normalized = normalizeForMatching(line.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, ''))
  const englishStarts = ['executive summary', 'key facts', 'technology and use case', 'token information']
  const vietnameseStarts = ['tom tat', 'thong tin chinh', 'cong nghe', 'thong tin token']
  return [...englishStarts, ...(language === 'vi' ? vietnameseStarts : [])].some((heading) => normalized.includes(heading))
}

function wantsOfficialSources(query: string) {
  return /official sources only|official only|only official|nguon chinh thuc|chinh thuc/i.test(normalizeForMatching(query))
}

function ensureResearchNotice(content: string, language: Language) {
  if (/financial advice|not financial advice|nfa|khong phai|khong.*tu van|khong.*loi khuyen/i.test(content)) return content
  const notice =
    language === 'vi'
      ? 'Không phải lời khuyên tài chính. Báo cáo này chỉ phục vụ mục đích nghiên cứu.'
      : 'Not financial advice. This report is for research only.'
  return `${content.trim()}\n\n## ${language === 'vi' ? 'Lưu ý không phải lời khuyên tài chính' : 'Not financial advice'}\n${notice}`
}

function structuredReportToText(report: ResearchReportData, language: Language) {
  const labels =
    language === 'vi'
      ? {
          summary: 'Tóm tắt điều hành',
          facts: 'Thông tin chính',
          technology: 'Công nghệ và trường hợp sử dụng',
          token: 'Thông tin token',
          positives: 'Tín hiệu tích cực',
          risks: 'Rủi ro và tuyên bố chưa thể xác minh',
          sources: 'Nguồn',
          notice: 'Lưu ý không phải lời khuyên tài chính',
        }
      : {
          summary: 'Executive summary',
          facts: 'Key facts',
          technology: 'Technology and use case',
          token: 'Token information',
          positives: 'Positive signals',
          risks: 'Risks and unverifiable claims',
          sources: 'Sources',
          notice: 'Not financial advice',
        }
  const sections: Array<[string, string[]]> = [
    [labels.summary, report.executiveSummary],
    [labels.facts, report.keyFacts],
    [labels.technology, report.technologyAndUseCase],
    [labels.token, report.tokenInformation],
    [labels.positives, report.positiveSignals],
    [labels.risks, report.risksAndUnverifiableClaims],
    [labels.sources, report.sourceLinks.map((source) => source.url)],
    [labels.notice, [report.notFinancialAdvice]],
  ]

  return sections
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => `${title}\n${items.map((item) => `- ${item}`).join('\n')}`)
    .join('\n\n')
}

function fallbackReportToText(identity: z.infer<typeof IdentityVerified>, markdown: string, sourceLinks: SourceLinkData[], language: Language) {
  const label = language === 'vi' ? 'Nguồn' : 'Sources'
  const identityText = identityToText(identity, language)
  const sourceText = sourceLinks.length
    ? `\n\n${label}\n${sourceLinks.map((source) => `- ${source.url}`).join('\n')}`
    : ''
  return `${identityText}\n\n${markdownToPlainText(markdown)}${sourceText}`
}

function domainTitle(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'Source'
  }
}

function markdownToPlainText(markdown: string) {
  return markdown
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^[-*]\s+/, '- ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^---+$/, '---')
        .trimEnd(),
    )
    .join('\n')
    .trim()
}

function identityToText(identity: z.infer<typeof IdentityVerified>, language: Language) {
  const labels =
    language === 'vi'
      ? ['Danh tính đã xác minh', 'Tên', 'Ký hiệu', 'Tên miền chính thức', 'Blockchain', 'Chain ID', 'Địa chỉ hợp đồng']
      : ['Verified identity', 'Name', 'Symbol', 'Official domain', 'Blockchain', 'Chain ID', 'Contract address']
  const rows = [
    identity.name ? `${labels[1]}: ${identity.name}` : null,
    identity.symbol ? `${labels[2]}: ${identity.symbol}` : null,
    identity.officialDomain ? `${labels[3]}: ${identity.officialDomain}` : null,
    identity.blockchain ? `${labels[4]}: ${identity.blockchain}` : null,
    identity.chainId ? `${labels[5]}: ${identity.chainId}` : null,
    identity.contractAddress ? `${labels[6]}: ${identity.contractAddress}` : null,
  ].filter((row): row is string => Boolean(row))
  return `${labels[0]}\n${rows.map((row) => `- ${row}`).join('\n')}`
}
