# ChainBrief AI

ChainBrief AI is a bilingual crypto research agent built from the Orbio starter repository. It helps users research tokens, projects, contract addresses, and crypto questions, then turns a completed report into an editable X or Binance Square draft.

This project is research-only. It never publishes social posts, never connects to X or Binance accounts, never signs transactions, and never performs trades.

## Features

- English and Vietnamese research reports.
- Optional identity constraint field for official URL, contract address, or blockchain.
- Web-grounded research through OpenRouter server-side web search.
- Entity-resolution guardrails for same-name crypto projects.
- Verified identity panel with project name, symbol, official domain, blockchain, chain ID, and contract when verified.
- Report sections for executive summary, key facts, technology/use case, token information, positive signals, risks, sources, and not-financial-advice notice.
- Safe Markdown rendering without unsafe HTML injection.
- Optional X and Binance Square draft generation.
- Human approval workflow before copying a generated social draft.
- Draft factual sanitizer that removes unsupported hard facts and keeps the research report visible.
- `/api/health` endpoint for non-paid server/config/OpenRouter connectivity checks.
- Optional `DEMO_ACCESS_CODE` protection for paid endpoints when deployed publicly.

## Architecture

- `src/server.ts` runs a small TypeScript HTTP server.
- `src/lib/openrouter.ts` loads `.env.local` server-side and creates the OpenRouter client.
- `src/lib/identity.ts` handles identity hints, URL canonicalization, verified identity extraction, and conflict detection.
- `src/lib/social.ts` normalizes social model output, validates hard facts, shortens X drafts, and creates deterministic fallbacks.
- `src/public/` contains the browser UI. It never reads `OPENROUTER_API_KEY`.
- `tests/` contains mocked regression tests for identity resolution, report normalization, social draft safety, and UI behavior checks.

The browser sends requests only to the local server. The server is the only place that can access OpenRouter credentials.

## Local Installation

Requirements:

- Windows PowerShell
- Node.js 22 or newer
- pnpm
- An OpenRouter API key stored in `.env.local`

Install dependencies:

```powershell
pnpm.cmd install
```

Create local environment config:

```powershell
Copy-Item .env.example .env.local
```

Edit `.env.local` locally. Do not commit it.

## Environment Variables

Required:

```env
OPENROUTER_API_KEY=
```

Optional:

```env
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_IMAGE_MODEL=openai/gpt-image-1
APP_NAME=ChainBrief AI
APP_URL=http://localhost:5173
DEMO_ACCESS_CODE=
PAID_CONCURRENCY_MAX=2
PORT=5173
```

`DEMO_ACCESS_CODE` is optional. When set, `/api/research` and `/api/social` require the same value in the `x-demo-access-code` request header. The local UI includes a password field for this value.

## Development

Run the development server:

```powershell
pnpm.cmd dev
```

Open:

```text
http://localhost:5173
```

Run checks:

```powershell
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd test
pnpm.cmd audit
```

## Production

Build:

```powershell
pnpm.cmd build
```

Start:

```powershell
pnpm.cmd start
```

Use a process manager or platform runtime to keep the process alive. Set `DEMO_ACCESS_CODE` before public demos if you need to limit use of paid endpoints.

## Health Check

`GET /api/health` returns:

- server status and port
- whether OpenRouter configuration is present
- whether demo access-code protection is enabled
- non-generation OpenRouter connectivity via `GET /api/v1/models`

The health endpoint does not expose secrets and does not make a paid model request.

## Safety Design

- `OPENROUTER_API_KEY` is loaded only on the server.
- `.env.local` is ignored by Git.
- API responses and logs redact OpenRouter key patterns and bearer tokens.
- Paid endpoints have request-size limits, per-client rate limiting, safe concurrency limits, and request timeouts.
- Public deployments can set `DEMO_ACCESS_CODE` to protect paid endpoints.
- The app does not enable unrestricted CORS.
- User-supplied URLs are validated before paid research requests. Unsupported protocols, localhost, loopback, and private-network IP URLs are rejected.
- Social drafts are generated as editable drafts only. Copy stays disabled until explicit human approval.
- Editing an approved draft resets approval.
- Unsupported hard facts in social drafts are removed or replaced with a deterministic fallback based on the displayed report.

## Known Limitations

- Research quality depends on OpenRouter model/provider availability and web-search results.
- The app can verify only information present in model output, source URLs, annotations, official domains, or authoritative explorer references.
- The social validator checks hard facts such as numbers, dates, addresses, domains, chains, token symbols, and audit/security-score claims. It is not a full truth engine.
- URL safety checks block direct private IP and localhost URLs, but they do not resolve every public hostname to detect private DNS targets because the server does not fetch user-supplied URLs directly.
- No database or user accounts are included in v0.1.0.

## Build Week Attribution

Built for Orbio Build Week as a public v0.1.0 MVP using the Orbio starter and OpenRouter.
