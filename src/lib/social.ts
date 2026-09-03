import { z } from 'zod'
import { normalizeForMatching, type IdentityVerifiedData } from './identity.js'

export const SocialDraftRequest = z.object({
  identity: z.object({
    name: z.string().nullable().default(null),
    symbol: z.string().nullable().default(null),
    officialDomain: z.string().nullable().default(null),
    blockchain: z.string().nullable().default(null),
    chainId: z.string().nullable().default(null),
    contractAddress: z.string().nullable().default(null),
  }),
  report: z.string().trim().min(50).max(12000),
  language: z.enum(['en', 'vi']),
  channel: z.enum(['x', 'binance']),
})

export type SocialChannel = z.infer<typeof SocialDraftRequest>['channel']
export type SocialLanguage = z.infer<typeof SocialDraftRequest>['language']

const URL_PATTERN = /https?:\/\/[^\s<>)\]}"]+/g
const DOMAIN_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi
const CONTRACT_PATTERN = /0x[a-fA-F0-9]{40}/g
const NUMBER_PATTERN = /(?<![A-Za-z0-9])(?:\d+(?:\.\d+)?(?:\/\d+)?%?)(?![A-Za-z0-9])/g
const TOKEN_SYMBOL_PATTERN = /\b[A-Z][A-Z0-9]{1,9}\b/g
const KNOWN_CHAINS = [
  'Robinhood Chain',
  'Solana',
  'Ethereum',
  'Base',
  'BNB Chain',
  'Binance Smart Chain',
  'Polygon',
  'Arbitrum',
  'Optimism',
  'Avalanche',
  'Bitcoin',
]
const SYMBOL_ALLOWLIST = new Set(['AI', 'API', 'DAO', 'DEX', 'ID', 'NFA', 'NFT', 'TVL', 'URL', 'USD', 'USDC', 'USDT', 'BTC', 'ETH'])
const MIN_FALLBACK_LENGTH = { x: 70, binance: 140 } as const

export function socialPrompt(args: {
  identity: IdentityVerifiedData
  report: string
  language: SocialLanguage
  channel: SocialChannel
}) {
  const languageName = args.language === 'vi' ? 'Vietnamese' : 'English'
  const platform = args.channel === 'x' ? 'X' : 'Binance Square'
  const lengthRule =
    args.channel === 'x'
      ? 'Stay within 280 characters. Use a natural hook first and focus on one or two useful verified insights.'
      : 'May be longer. Include a hook, useful explanation, verified facts, risks already present in the report, and a short disclaimer.'

  return [
    `Write one ${platform} draft entirely in ${languageName}.`,
    lengthRule,
    'Use only the normalized verified identity and the final displayed research report below.',
    'Do not search the web. Do not introduce any new fact, number, score, date, chain, contract, domain, or risk claim.',
    'Never describe a verified contract, domain, or blockchain as unverified.',
    'Avoid hype, price predictions, financial advice, and trading instructions.',
    'Return JSON only: {"post":"..."}',
    '',
    'Verified identity:',
    identityToPrompt(args.identity),
    '',
    'Final displayed report:',
    args.report,
  ].join('\n')
}

export function normalizeSocialPostText(value: unknown) {
  const extracted = extractPostValue(value, 0)
  return cleanPostText(typeof extracted === 'string' ? extracted : String(value ?? ''))
}

export function sanitizeSocialDraft(args: {
  draft: string
  identity: IdentityVerifiedData
  report: string
  channel: SocialChannel
  language?: SocialLanguage
}) {
  const allowedFacts = buildAllowedFacts(args.identity, args.report)
  const removedReasons: string[] = []
  const keptParagraphs = args.draft
    .split(/\n{2,}/)
    .map((paragraph) => {
      const keptSentences = splitDraftSentences(paragraph).filter((sentence) => {
        const reason = hardFactViolation(sentence, allowedFacts, args.identity)
        if (reason) {
          removedReasons.push(reason)
          return false
        }
        return true
      })
      return joinSentences(keptSentences)
    })
    .filter(Boolean)

  let draft = keptParagraphs.join('\n\n').trim()
  const usedFallback = isTooShort(draft, args.channel)
  if (usedFallback) {
    draft = createDeterministicFallbackDraft({
      identity: args.identity,
      report: args.report,
      channel: args.channel,
      language: args.language ?? 'en',
    })
  }

  if (args.channel === 'x') draft = shortenXDraft(draft)

  return {
    draft,
    changed: draft.trim() !== args.draft.trim() || removedReasons.length > 0,
    removedReasons: unique(removedReasons),
    usedFallback,
  }
}

export function validateSocialDraft(args: {
  draft: string
  identity: IdentityVerifiedData
  report: string
  channel: SocialChannel
}) {
  const sanitized = sanitizeSocialDraft({ ...args, language: 'en' })
  if (sanitized.removedReasons.length > 0) return { ok: false as const, reason: sanitized.removedReasons[0] }
  if (args.channel === 'x' && [...args.draft].length > 280) return { ok: false as const, reason: 'x_character_limit_exceeded' }
  return { ok: true as const }
}

export function createDeterministicFallbackDraft(args: {
  identity: IdentityVerifiedData
  report: string
  channel: SocialChannel
  language: SocialLanguage
}) {
  const name = displayName(args.identity)
  const summary = extractSummarySentences(args.report, args.language).slice(0, args.channel === 'x' ? 1 : 2)
  const identityFacts = [
    args.identity.officialDomain ? `${args.language === 'vi' ? 'domain chính thức' : 'official domain'} ${args.identity.officialDomain}` : null,
    args.identity.blockchain ? `${args.language === 'vi' ? 'blockchain' : 'blockchain'} ${args.identity.blockchain}` : null,
  ].filter(Boolean)

  if (args.channel === 'x') {
    const lead =
      args.language === 'vi'
        ? `${name}: ghi chú nghiên cứu dựa trên ${identityFacts.join(' và ') || 'danh tính đã xác minh'}.`
        : `${name}: research note based on ${identityFacts.join(' and ') || 'verified identity'}.`
    const notice = args.language === 'vi' ? 'Không phải lời khuyên tài chính.' : 'Not financial advice.'
    return shortenXDraft([lead, summary[0], notice].filter(Boolean).join(' '))
  }

  const hook =
    args.language === 'vi'
      ? `${name} cần được đánh giá bằng các dữ liệu đã xác minh.`
      : `${name} is worth reading through verified source material.`
  const facts =
    identityFacts.length > 0
      ? args.language === 'vi'
        ? `Thông tin đã xác minh: ${identityFacts.join('; ')}.`
        : `Verified facts: ${identityFacts.join('; ')}.`
      : ''
  const caution =
    args.language === 'vi'
      ? 'Các điểm chưa được chứng minh rõ nên được xem là chưa xác minh. Không phải lời khuyên tài chính.'
      : 'Treat unclear or weakly sourced claims as unverified. Not financial advice.'

  return [hook, facts, ...summary, caution].filter(Boolean).join('\n\n')
}

export function shortenXDraft(draft: string) {
  const normalized = draft.replace(/\s+/g, ' ').trim()
  if ([...normalized].length <= 280) return normalized

  const sentences = splitDraftSentences(normalized)
  const kept: string[] = []
  for (const sentence of sentences) {
    const candidate = [...kept, sentence].join(' ')
    if ([...candidate].length <= 260) kept.push(sentence)
  }

  const nfa = /\b(nfa|not financial advice|khong phai loi khuyen tai chinh)\b/i.test(normalized)
    ? ''
    : ' Not financial advice.'
  const candidate = `${kept.join(' ')}${nfa}`.trim()
  if (candidate && [...candidate].length <= 280) return candidate

  return `${normalized.slice(0, 276).trimEnd()}...`
}

export function approvalInitialState() {
  return {
    approved: false,
    copyEnabled: false,
    label: 'Draft - approval required',
  }
}

export function approvalAfterApprove() {
  return {
    approved: true,
    copyEnabled: true,
    label: 'Approved draft',
  }
}

export function approvalAfterEdit() {
  return approvalInitialState()
}

function identityToPrompt(identity: IdentityVerifiedData) {
  return [
    identity.name ? `Name: ${identity.name}` : null,
    identity.symbol ? `Symbol: ${identity.symbol}` : null,
    identity.officialDomain ? `Official domain: ${identity.officialDomain}` : null,
    identity.blockchain ? `Blockchain: ${identity.blockchain}` : null,
    identity.chainId ? `Chain ID: ${identity.chainId}` : null,
    identity.contractAddress ? `Contract address: ${identity.contractAddress}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

function extractPostValue(value: unknown, depth: number): unknown {
  if (depth > 5) return value

  if (value && typeof value === 'object' && 'post' in value) {
    const post = (value as { post?: unknown }).post
    if (typeof post === 'string') return post
  }

  if (typeof value !== 'string') return value

  const text = stripCodeFence(value.trim())
  for (const candidate of jsonTextCandidates(text)) {
    const parsed = safeJsonParse(candidate)
    if (parsed.ok) return extractPostValue(parsed.value, depth + 1)
  }

  return text
}

function jsonTextCandidates(text: string) {
  const candidates = [text]
  const fenced = text.match(/```(?:json|text)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))

  if (text.includes('\\"')) {
    candidates.push(text.replace(/\\"/g, '"'))
    candidates.push(text.replace(/\\"/g, '"').replace(/\\\\n/g, '\\n'))
  }

  return unique(candidates).filter(Boolean)
}

function stripCodeFence(text: string) {
  const fenced = text.match(/^```(?:json|text)?\s*([\s\S]*?)```\s*$/i)
  return fenced?.[1]?.trim() ?? text
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function cleanPostText(text: string) {
  return stripCodeFence(text)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildAllowedFacts(identity: IdentityVerifiedData, report: string) {
  const allowedText = `${identityToPrompt(identity)}\n${report}`
  const textWithoutUrlsAndContracts = allowedText.replace(URL_PATTERN, ' ').replace(CONTRACT_PATTERN, ' ')
  return {
    normalizedText: normalizeForMatching(allowedText),
    contracts: new Set(unique([...(allowedText.match(CONTRACT_PATTERN) ?? []), identity.contractAddress].filter(isString)).map((value) => value.toLowerCase())),
    domains: new Set(unique([...extractDomains(allowedText), identity.officialDomain].filter(isString).map((domain) => domain.toLowerCase()))),
    numbers: new Set(unique(textWithoutUrlsAndContracts.match(NUMBER_PATTERN) ?? [])),
    chains: new Set(KNOWN_CHAINS.filter((chain) => containsNormalized(allowedText, chain)).map((chain) => normalizeForMatching(chain))),
    symbols: new Set(
      unique([...(allowedText.match(TOKEN_SYMBOL_PATTERN) ?? []), identity.symbol].filter(isTokenSymbol)).map((symbol) => symbol.toUpperCase()),
    ),
  }
}

function hardFactViolation(sentence: string, allowedFacts: ReturnType<typeof buildAllowedFacts>, identity: IdentityVerifiedData) {
  for (const contract of unique(sentence.match(CONTRACT_PATTERN) ?? [])) {
    if (!allowedFacts.contracts.has(contract.toLowerCase())) return 'unsupported_contract'
  }

  for (const domain of extractDomains(sentence)) {
    if (!allowedFacts.domains.has(domain.toLowerCase())) return 'unsupported_domain'
  }

  const sentenceWithoutUrlsAndContracts = sentence.replace(URL_PATTERN, ' ').replace(CONTRACT_PATTERN, ' ')
  for (const number of unique(sentenceWithoutUrlsAndContracts.match(NUMBER_PATTERN) ?? [])) {
    if (number.length < 2 && number !== '0') continue
    if (!allowedFacts.numbers.has(number)) return 'unsupported_number'
  }

  for (const chain of KNOWN_CHAINS) {
    if (containsNormalized(sentence, chain) && !allowedFacts.chains.has(normalizeForMatching(chain))) {
      return 'unsupported_blockchain'
    }
  }

  for (const symbol of unique(sentence.match(TOKEN_SYMBOL_PATTERN) ?? [])) {
    if (!isTokenSymbol(symbol)) continue
    if (!allowedFacts.symbols.has(symbol.toUpperCase())) return 'unsupported_symbol'
  }

  if (identity.contractAddress && describesAsUnverified(sentence, ['contract', 'hop dong', 'hợp đồng'])) {
    return 'verified_contract_marked_unverified'
  }

  if (identity.officialDomain && describesAsUnverified(sentence, ['domain', 'ten mien', 'tên miền'])) {
    return 'verified_domain_marked_unverified'
  }

  if (identity.blockchain && describesAsUnverified(sentence, ['chain', 'blockchain'])) {
    return 'verified_blockchain_marked_unverified'
  }

  if (containsSecurityAuditClaim(sentence) && !containsNormalized(allowedFacts.normalizedText, sentence)) {
    return 'unsupported_audit_claim'
  }

  return ''
}

function extractDomains(text: string) {
  const fromUrls = (text.match(URL_PATTERN) ?? []).map((url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      return ''
    }
  })
  const domains = text.match(DOMAIN_PATTERN) ?? []
  return unique([...fromUrls, ...domains].filter(Boolean).map((domain) => domain.replace(/^www\./, '').toLowerCase()))
}

function describesAsUnverified(text: string, targets: string[]) {
  const normalized = normalizeForMatching(text)
  return targets.some(
    (target) =>
      normalized.includes(target) &&
      /(unverified|not verified|chua xac minh|khong xac minh|chưa xác minh|không xác minh)/i.test(normalized),
  )
}

function containsSecurityAuditClaim(text: string) {
  return /(security score|audit(ed)? by|audited|contract audit|diem bao mat|kiem toan|kiểm toán|điểm bảo mật)/i.test(
    normalizeForMatching(text),
  )
}

function splitDraftSentences(draft: string) {
  return draft
    .replace(/\r\n/g, '\n')
    .split(/\n+|(?<=[!?。！？])\s+|(?<=[.])\s+(?=(?:[A-ZÀ-Ỹ0-9]|["“]))/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function joinSentences(sentences: string[]) {
  return sentences.join(' ').replace(/\s+/g, ' ').trim()
}

function isTooShort(draft: string, channel: SocialChannel) {
  return [...draft.trim()].length < MIN_FALLBACK_LENGTH[channel]
}

function displayName(identity: IdentityVerifiedData) {
  if (identity.name && identity.symbol) return `${identity.name} (${identity.symbol})`
  return identity.name ?? identity.symbol ?? identity.officialDomain ?? 'Project'
}

function extractSummarySentences(report: string, language: SocialLanguage) {
  const headingPatterns =
    language === 'vi'
      ? [/tom tat dieu hanh/i, /tóm tắt điều hành/i]
      : [/executive summary/i]
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

  const start = lines.findIndex((line) => headingPatterns.some((pattern) => pattern.test(normalizeForMatching(line))))
  const candidates = (start >= 0 ? lines.slice(start + 1) : lines).filter((line) => {
    const normalized = normalizeForMatching(line)
    return !/^(verified identity|sources|not financial advice|key facts|technology|token information|positive signals|risks)/i.test(
      normalized,
    )
  })

  return candidates.slice(0, 3)
}

function isString(value: string | null | undefined): value is string {
  return Boolean(value)
}

function isTokenSymbol(value: string | null | undefined): value is string {
  return Boolean(value && value.length >= 2 && !SYMBOL_ALLOWLIST.has(value.toUpperCase()))
}

function containsNormalized(haystack: string, needle: string) {
  return normalizeForMatching(haystack).includes(normalizeForMatching(needle))
}

function unique(values: string[]) {
  return [...new Set(values)]
}
