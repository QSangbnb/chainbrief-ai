import { z } from 'zod'

export const IdentityVerified = z.object({
  name: z.string().nullable().default(null),
  symbol: z.string().nullable().default(null),
  officialDomain: z.string().nullable().default(null),
  blockchain: z.string().nullable().default(null),
  chainId: z.string().nullable().default(null),
  contractAddress: z.string().nullable().default(null),
})

export const DisambiguationCandidate = z.object({
  name: z.string(),
  blockchain: z.string().default('not verified'),
  contractAddress: z.string().nullable().default(null),
  domain: z.string().default('not verified'),
})

export type IdentityVerifiedData = z.infer<typeof IdentityVerified>
export type DisambiguationCandidateData = z.infer<typeof DisambiguationCandidate>

export type IdentityConstraints = {
  officialUrl?: string
  officialDomain?: string
  blockchain?: string
  chainId?: string
  contractAddress?: string
}

const CONTRACT_PATTERN = /0x[a-fA-F0-9]{40}/g
const URL_PATTERN = /https?:\/\/[^\s<>)\]}"]+/g
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

export function parseIdentityHint(hint: string | undefined): IdentityConstraints {
  const value = hint?.trim()
  if (!value) return {}

  const officialUrl = firstMatch(value, URL_PATTERN)
  const contractAddress = firstMatch(value, CONTRACT_PATTERN)
  const officialDomain = officialUrl ? domainFromUrl(officialUrl) : undefined
  const parsedChain = parseBlockchain(value)

  return compactIdentity({
    officialUrl,
    officialDomain,
    blockchain: parsedChain.blockchain ?? undefined,
    chainId: parsedChain.chainId ?? undefined,
    contractAddress,
  })
}

export function hasIdentityConstraints(identity: IdentityConstraints) {
  return Boolean(identity.officialDomain || identity.blockchain || identity.chainId || identity.contractAddress)
}

export function identityPrompt(identity: IdentityConstraints, officialOnly: boolean) {
  if (!hasIdentityConstraints(identity)) return ''

  const lines = [
    'Hard identity constraints supplied by the user:',
    identity.officialUrl ? `Official URL: ${identity.officialUrl}` : undefined,
    identity.officialDomain ? `Official domain: ${identity.officialDomain}` : undefined,
    identity.blockchain ? `Blockchain: ${identity.blockchain}` : undefined,
    identity.chainId ? `Chain ID: ${identity.chainId}` : undefined,
    identity.contractAddress ? `Contract address: ${identity.contractAddress}` : undefined,
    'Treat these as hard constraints. If search results point to a different domain, chain, chain ID, or contract, reject that entity as unrelated.',
    officialOnly || identity.officialDomain
      ? 'Official sources only means the supplied official domain, its docs subdomains, source repositories linked from that domain, and authoritative blockchain explorers for the supplied chain or contract.'
      : undefined,
  ]

  return lines.filter(Boolean).join('\n')
}

export function identityFromConstraints(identity: IdentityConstraints): IdentityVerifiedData {
  return normalizeIdentity({
    name: null,
    symbol: null,
    officialDomain: identity.officialDomain ?? null,
    blockchain: identity.blockchain ?? null,
    chainId: identity.chainId ?? null,
    contractAddress: identity.contractAddress ?? null,
  })
}

export function mergeVerifiedIdentity(
  verified: IdentityVerifiedData,
  constraints: IdentityConstraints,
): IdentityVerifiedData {
  return normalizeIdentity({
    name: verified.name,
    symbol: verified.symbol,
    officialDomain: constraints.officialDomain ?? verified.officialDomain,
    blockchain: constraints.blockchain ?? verified.blockchain,
    chainId: constraints.chainId ?? verified.chainId,
    contractAddress: constraints.contractAddress ?? verified.contractAddress,
  })
}

export function normalizeIdentity(identity: IdentityVerifiedData): IdentityVerifiedData {
  const chain = splitChainAndId(identity.blockchain)

  return {
    name: cleanUnknown(identity.name),
    symbol: cleanUnknown(identity.symbol),
    officialDomain: canonicalDomain(identity.officialDomain),
    blockchain: cleanUnknown(chain.blockchain),
    chainId: cleanUnknown(identity.chainId) ?? chain.chainId,
    contractAddress: cleanUnknown(identity.contractAddress),
  }
}

export function extractVerifiedIdentityFromText(text: string, sourceUrls: string[] = []): IdentityVerifiedData {
  const identity = IdentityVerified.parse({})
  const sourceDomains = sourceUrls.map(domainFromUrl).filter((domain): domain is string => Boolean(domain))
  const matchingDomain = sourceDomains.find((domain) => text.includes(domain))
  if (matchingDomain) identity.officialDomain = matchingDomain

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim()
    const [rawLabel, ...rest] = line.split(':')
    const value = rest.join(':').trim()
    if (!rawLabel || !value) continue

    const label = normalizeForMatching(rawLabel)
    if (/^(project\/token name|project name|token name|name|ten du an\/token|ten du an|ten token|ten)$/.test(label)) {
      identity.name = value
    } else if (/^(symbol|ticker|ky hieu)$/.test(label)) {
      identity.symbol = value
    } else if (/^(official domain|domain|ten mien chinh thuc)$/.test(label)) {
      identity.officialDomain = value
    } else if (/^(blockchain|chain)$/.test(label)) {
      const chain = splitChainAndId(value)
      identity.blockchain = chain.blockchain
      identity.chainId = identity.chainId ?? chain.chainId
    } else if (/^(chain id|chainid)$/.test(label)) {
      identity.chainId = value
    } else if (/^(contract address|contract|dia chi hop dong)$/.test(label)) {
      identity.contractAddress = value
    }
  }

  return normalizeIdentity(identity)
}

export function splitChainAndId(value: string | null | undefined) {
  const cleaned = cleanUnknown(value)
  if (!cleaned) return { blockchain: null, chainId: null }

  const chainIdMatch = cleaned.match(/\bchain\s*id\s*[:#]?\s*(\d+)\b/i)
  const chainId = chainIdMatch?.[1] ?? null
  const blockchain = cleaned
    .replace(/\(\s*chain\s*id\s*[:#]?\s*\d+\s*\)/i, '')
    .replace(/\bchain\s*id\s*[:#]?\s*\d+\b/i, '')
    .trim()

  return { blockchain: blockchain || null, chainId }
}

export function detectIdentityConflict(args: {
  text: string
  sourceUrls: string[]
  identity: IdentityVerifiedData
  constraints: IdentityConstraints
}): string | undefined {
  const { text, sourceUrls, identity, constraints } = args
  const normalizedText = normalizeForMatching(text)

  if (constraints.contractAddress) {
    const expected = constraints.contractAddress.toLowerCase()
    const contracts = [...new Set(text.match(CONTRACT_PATTERN) ?? [])].map((contract) => contract.toLowerCase())
    const reportedContract = identity.contractAddress?.toLowerCase()
    if (reportedContract && reportedContract !== expected) return 'verified contract conflicts with the supplied identity'

    const mentionsExpected = contracts.includes(expected)
    const mentionsOnlyOtherContracts = contracts.length > 0 && !mentionsExpected
    if (mentionsOnlyOtherContracts) return 'contract address conflicts with the supplied identity'
  }

  if (constraints.blockchain) {
    const expected = normalizeForMatching(constraints.blockchain)
    const reported = identity.blockchain ? normalizeForMatching(identity.blockchain) : null
    if (reported && reported !== expected) return 'verified blockchain conflicts with the supplied identity'

    const conflictingChain = KNOWN_CHAINS.map((chain) => normalizeForMatching(chain)).find(
      (chain) => chain !== expected && normalizedText.includes(chain),
    )
    if (conflictingChain) return 'report mentions a conflicting blockchain'
  }

  if (constraints.chainId && identity.chainId && constraints.chainId !== identity.chainId) {
    return 'verified chain ID conflicts with the supplied identity'
  }

  if (constraints.officialDomain) {
    const expectedDomain = normalizeDomain(constraints.officialDomain)
    const reportedDomain = identity.officialDomain ? normalizeDomain(identity.officialDomain) : null
    if (reportedDomain && !isSameOrSubdomain(reportedDomain, expectedDomain)) {
      return 'verified domain conflicts with the supplied official domain'
    }

    const sourceDomains = sourceUrls
      .map(domainFromUrl)
      .filter((domain): domain is string => Boolean(domain))
      .map((domain) => normalizeDomain(domain))
    if (sourceDomains.length > 0 && !sourceDomains.some((domain) => isSameOrSubdomain(domain, expectedDomain))) {
      return 'sources do not include the supplied official domain'
    }
  }

  return undefined
}

export function normalizeForMatching(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
}

function parseBlockchain(value: string) {
  const labeled = value.match(/(?:blockchain|chain|mang|mạng)\s*:\s*([^\n,;]+)/i)?.[1]?.trim()
  if (labeled) return splitChainAndId(labeled)

  const withoutUrlsAndContracts = value
    .replace(URL_PATTERN, ' ')
    .replace(CONTRACT_PATTERN, ' ')
    .replace(/official\s*url\s*:|contract\s*(address)?\s*:|blockchain\s*:|chain\s*:/gi, ' ')
    .trim()

  const known = KNOWN_CHAINS.find((chain) => normalizeForMatching(withoutUrlsAndContracts).includes(normalizeForMatching(chain)))
  return { blockchain: known ?? null, chainId: splitChainAndId(withoutUrlsAndContracts).chainId }
}

function compactIdentity(identity: IdentityConstraints): IdentityConstraints {
  return Object.fromEntries(Object.entries(identity).filter(([, value]) => Boolean(value))) as IdentityConstraints
}

function firstMatch(value: string, pattern: RegExp) {
  pattern.lastIndex = 0
  const match = pattern.exec(value)
  return match?.[0]?.replace(/[.,;:!?]+$/, '')
}

function domainFromUrl(url: string | undefined) {
  if (!url) return undefined
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return undefined
  }
}

function canonicalDomain(value: string | null | undefined) {
  const cleaned = cleanUnknown(value)
  if (!cleaned) return null
  const fromUrl = domainFromUrl(cleaned)
  return normalizeDomain(fromUrl ?? cleaned.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
}

function normalizeDomain(domain: string) {
  return domain.replace(/^www\./, '').toLowerCase()
}

function isSameOrSubdomain(candidate: string, expected: string) {
  return candidate === expected || candidate.endsWith(`.${expected}`)
}

function cleanUnknown(value: string | null | undefined) {
  const cleaned = value?.trim()
  if (!cleaned || /^not verified$/i.test(cleaned) || /^chưa xác minh$/i.test(cleaned)) return null
  return cleaned
}
