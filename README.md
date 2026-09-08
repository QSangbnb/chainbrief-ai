# ChainBrief AI

ChainBrief AI is a bilingual crypto research agent built from the Orbio starter repository. It helps users research tokens, projects, contract addresses, and crypto questions, then turns a completed report into an editable X, Threads, or Binance Square draft.

This project is research-only. It never publishes social posts, never connects to X or Binance accounts, never signs transactions, and never performs trades.

## Features

- English and Vietnamese research reports.
- Required Supabase authentication with email/password or Google before paid research endpoints can be used.
- Optional identity constraint field for official URL, contract address, or blockchain.
- Web-grounded research through OpenRouter server-side web search.
- Entity-resolution guardrails for same-name crypto projects.
- Verified identity panel with project name, symbol, official domain, blockchain, chain ID, and contract when verified.
- Report sections for executive summary, key facts, technology/use case, token information, positive signals, risks, sources, and not-financial-advice notice.
- Safe Markdown rendering without unsafe HTML injection.
- Optional X and Binance Square draft generation.
- Human approval workflow before copying a generated social draft.
- Per-account research history with search, rename, delete, and reopen actions.
- Markdown download, print-to-PDF, and private-by-default public share links.
- Per-account watchlist with one-click fresh research.
- Source-type badges for official domains, documentation, repositories, explorers, and external sources.
- Admin-only runtime and OpenRouter API-key usage dashboard.
- Draft factual sanitizer that removes unsupported hard facts and keeps the research report visible.
- `/api/health` endpoint for non-paid server/config/OpenRouter connectivity checks.
- Server-side validation of every Supabase access token before `/api/research` or `/api/social` runs.
- Optional `DEMO_ACCESS_CODE` protection as an additional private-demo gate.

## Architecture

- `src/server.ts` runs a small TypeScript HTTP server.
- `src/lib/openrouter.ts` loads `.env.local` server-side and creates the OpenRouter client.
- `src/lib/auth.ts` validates Supabase bearer tokens server-side before paid work begins.
- `src/lib/storage.ts` accesses Supabase PostgREST using the signed-in user's bearer token and RLS policies.
- `src/lib/identity.ts` handles identity hints, URL canonicalization, verified identity extraction, and conflict detection.
- `src/lib/social.ts` normalizes social model output, validates hard facts, shortens X drafts, and creates deterministic fallbacks.
- `src/public/` contains the browser UI and Supabase session client. It never reads `OPENROUTER_API_KEY`.
- `tests/` contains mocked regression tests for identity resolution, report normalization, social draft safety, and UI behavior checks.

The browser sends requests only to the local server. The server is the only place that can access OpenRouter credentials.

## Local Installation

Requirements:

- Windows PowerShell
- Node.js 22 or newer
- pnpm
- An OpenRouter API key stored in `.env.local`
- A Supabase project with email and/or Google authentication enabled

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
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_public_key
```

Optional:

```env
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_IMAGE_MODEL=openai/gpt-image-1
APP_NAME=ChainBrief AI
APP_URL=http://localhost:5173
ADMIN_EMAILS=owner@example.com
DEMO_ACCESS_CODE=
PAID_CONCURRENCY_MAX=2
PORT=5173
```

`SUPABASE_PUBLISHABLE_KEY` is designed to be public. Never place a Supabase `service_role` or secret key in this application. `DEMO_ACCESS_CODE` is optional; when set, it acts as an additional gate after Supabase authentication.

## Supabase Workspace Setup

Before deploying the saved history and watchlist UI, run this migration once in the Supabase SQL editor:

```text
supabase/migrations/20260908090000_chainbrief_workspace.sql
```

The migration creates `briefs` and `watchlist`, enables row-level security, and adds a narrowly scoped function for unguessable read-only share links. Users can access only their own records. No service-role key is required or accepted by the app.

To enable the admin tab, set `ADMIN_EMAILS` on Render to one or more comma-separated account emails. Runtime request counters reset whenever Render restarts. OpenRouter usage is read from the configured API key without exposing the key.

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

Use a process manager or platform runtime to keep the process alive. Configure the production Site URL and redirect URL in Supabase Auth, then set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` on the hosting platform.

## Health Check

`GET /api/health` returns:

- server status and port
- whether OpenRouter configuration is present
- whether Supabase authentication is configured
- whether demo access-code protection is enabled
- non-generation OpenRouter connectivity via `GET /api/v1/models`

The health endpoint does not expose secrets and does not make a paid model request.

## Safety Design

- `OPENROUTER_API_KEY` is loaded only on the server.
- `/api/research` and `/api/social` fail closed unless a valid Supabase session is verified server-side.
- Only the public Supabase URL and publishable key are exposed to the browser; service-role keys are never used.
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
- Watchlist updates are user-triggered; automatic email alerts require a scheduler and transactional email provider that are not part of this release.
- Runtime admin counters reset when the Render process restarts.

## Build Week Attribution

Built for Orbio Build Week as a public v0.1.0 MVP using the Orbio starter and OpenRouter.
