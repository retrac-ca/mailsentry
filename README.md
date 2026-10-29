# MailSentry

**Know your inbox. Protect your email.**

MailSentry is a local-first, open-source email infrastructure health checker and mailbox cleanup tool from [RETRAC](https://retrac.ca). It inspects public DNS records for a domain and helps you review, dry-run, and execute conservative mailbox cleanup through official provider APIs.

> **Project status:** secure MVP implementation. The core, diagnostics, provider adapters, UI, safety controls, and test suite are implemented. Gmail and Microsoft Graph adapters are written against documented APIs but have **not been verified against live accounts** in this repository because no OAuth credentials were available. MailSentry has **not** undergone an independent security audit.

---

## Contents

- [What MailSentry does](#what-mailsentry-does)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Provider support](#provider-support)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [OAuth setup](#oauth-setup)
- [Using Email Health](#using-email-health)
- [Safe cleanup workflow](#safe-cleanup-workflow)
- [Architecture](#architecture)
- [Memory and performance](#memory-and-performance)
- [Security and privacy](#security-and-privacy)
- [Testing and validation](#testing-and-validation)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## What MailSentry does

### Email infrastructure diagnostics

Enter a domain (and optionally a DKIM selector) to inspect:

- **MX** — mail exchangers, priorities, null MX, missing or suspicious targets.
- **SPF** — single-record enforcement, mechanism syntax, `all` qualifier, DNS-lookup term count. Nested includes are **not** recursively evaluated.
- **DKIM** — published key for a selector you supply. Selectors are never guessed.
- **DMARC** — policy (`none` / `quarantine` / `reject`), percentage, reporting URIs, and basic tag validation.

Every finding reports severity, what was checked, what was observed, why it matters, a recommended next step, and whether the result is confirmed or inconclusive. DNS failures (NXDOMAIN, timeout, SERVFAIL, refusal) are distinguished instead of being collapsed into “misconfigured.”

### Mailbox cleanup

- Independently select **Inbox**, **Spam/Junk**, and **Trash/Deleted Items** — nothing is selected by default.
- Configure age, message size, newsletter/bulk heuristic, targeted senders, and never-clean allowlists. Starred, unread, and important messages are protected unless explicitly included.
- **Scan** and **preview** are strictly read-only and metadata-only. Full bodies and attachments are never downloaded.
- **Check read-only connection** verifies account identity, folder visibility, and basic metadata access without changing anything.
- Review counts, per-folder totals, size estimates, uncertain classifications, provider limitations, and a bounded message sample.
- **Dry-run** revalidates every message without changing anything.
- **Execute** requires the reviewed server-side plan, revalidates each message, works in bounded batches, and reports partial failures and uncertain outcomes honestly.
- Permanent deletion and Empty Trash require a second, typed confirmation that is enforced by the server and the execution core.

### Operational characteristics

- No permanent background worker, database, queue, or cloud service.
- No analytics, telemetry, advertising SDKs, or hidden external requests.
- OAuth tokens are held in local server memory only; nothing is written to disk.
- Runtime dependencies: **zero**. Development dependencies only.
- Responsive, keyboard-accessible interface with light and dark color schemes.

---

## What it deliberately does not do

- It does **not** send test emails or prove deliverability, inbox placement, reputation, or mail-server health.
- It does **not** modify DNS records, and it does not check blocklists, MTA-STS, BIMI, or DNSSEC.
- It does **not** recursively walk SPF include/redirect graphs or discover DKIM selectors automatically.
- It does **not** unsubscribe users, report messages as spam, or classify message content.
- It does **not** download message bodies or attachments during scans.
- It does **not** promise that permanently deleted mail can be recovered.
- It does **not** request Gmail's full-mailbox scope, so Gmail permanent delete and Empty Trash are disabled.
- It does **not** claim that DNS configuration alone guarantees authentication or delivery.
- It does **not** run any mailbox operation automatically on page load.
- It does **not** expose an account to the browser; all provider calls happen in the local server process.

---

## Provider support

| Provider                | OAuth              | Scan/preview       | Archive                       | Trash | Permanent delete                        | Empty Trash              | Live-verified                          |
| ----------------------- | ------------------ | ------------------ | ----------------------------- | ----- | --------------------------------------- | ------------------------ | -------------------------------------- |
| Gmail                   | Implemented (PKCE) | Yes, metadata only | Yes                           | Yes   | **Disabled** (needs full mailbox scope) | **Disabled**             | No — requires your Google OAuth client |
| Microsoft 365 / Outlook | Implemented (PKCE) | Yes, metadata only | Yes (requires Archive folder) | Yes   | Yes (typed confirmation)                | Yes (typed confirmation) | No — requires your Entra ID app        |

The app models these capabilities explicitly in `src/core/capabilities.ts` and disables unsupported or unsafe operations in both the UI and the server. Settings shows the scopes the provider actually granted, not only the scopes requested.

Live verification requires your own OAuth application registration. See [docs/PROVIDERS.md](docs/PROVIDERS.md) for setup and [docs/LIVE-VERIFICATION.md](docs/LIVE-VERIFICATION.md) for the evidence checklist before calling a provider verified.

---

## Requirements

- Node.js **22 or newer** (developed and benchmarked on Node 22.23.2).
- npm 10 or newer.
- Linux, macOS, Windows with WSL2, or another environment with a loopback network stack.
- No database, Docker, or external service.

---

## Quick start

```bash
git clone https://github.com/retrac-ca/mailsentry.git
cd mailsentry
npm ci
cp .env.example .env
npm run build
npm start
```

Open <http://127.0.0.1:4310>.

Email Health works without OAuth configuration. Mailbox Cleanup requires a Gmail or Microsoft OAuth client; the app shows setup guidance until one is configured.

### Development

```bash
npm run dev        # builds the browser bundle, then runs the TypeScript server with watch
npm run typecheck  # server + browser type checks
npm test           # unit and integration tests
npm run lint
```

The server binds to loopback by default. It refuses a non-loopback plain-HTTP base URL and refuses a non-loopback bind unless `MAILSENTRY_ALLOW_NONLOCAL=true` is explicitly set.

### CLI diagnostics

The same diagnostics engine is available without the UI:

```bash
npm run diagnose -- example.com
npm run diagnose -- example.com --selector 20230601
npm run diagnose -- example.com --json
```

The CLI performs a fixed set of public DNS lookups. It does not send mail or change records.

---

## Configuration

Copy `.env.example` to `.env`. `.env` is ignored by Git and is loaded automatically when the server starts; values already present in the process environment take precedence.

| Variable                  | Required      | Purpose                                                                                                                |
| ------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | No            | HTTP port. Default `4310`.                                                                                             |
| `MAILSENTRY_HOST`         | No            | Bind address. Default `127.0.0.1`; non-loopback requires explicit opt-in.                                              |
| `MAILSENTRY_BASE_URL`     | No            | Public base URL used for OAuth redirects. Default `http://127.0.0.1:${PORT}`. Origin only; its port must match `PORT`. |
| `MAILSENTRY_LOG_LEVEL`    | No            | `debug`, `info`, `warn`, or `error`. Default `info`.                                                                   |
| `GOOGLE_CLIENT_ID`        | For Gmail     | Google OAuth web client ID.                                                                                            |
| `GOOGLE_CLIENT_SECRET`    | No            | Optional server-side secret for the Google client.                                                                     |
| `MICROSOFT_CLIENT_ID`     | For Microsoft | Entra ID application (client) ID.                                                                                      |
| `MICROSOFT_CLIENT_SECRET` | No            | Optional server-side secret; public-client PKCE also works.                                                            |
| `MICROSOFT_TENANT_ID`     | No            | `common` (default), `organizations`, `consumers`, or a tenant ID.                                                      |

There is no credential persistence setting because credential persistence is intentionally not implemented.

---

## OAuth setup

Full step-by-step instructions, scopes, redirect URIs, and troubleshooting are in [docs/PROVIDERS.md](docs/PROVIDERS.md).

Short version:

1. Set `MAILSENTRY_BASE_URL` to the exact origin you use, e.g. `http://127.0.0.1:4310`. Do not include a path, and keep its port equal to `PORT`.
2. **Google:** create an OAuth 2.0 Web application client; add `http://127.0.0.1:4310/auth/gmail/callback`; set `GOOGLE_CLIENT_ID`.
3. **Microsoft:** create an Entra ID app registration; add `http://127.0.0.1:4310/auth/microsoft/callback`; enable public client flows if using PKCE without a secret; set `MICROSOFT_CLIENT_ID`.
4. Restart MailSentry and connect from **Settings** or **Mailbox Cleanup**.
5. Use **Check read-only connection** in Settings and follow [docs/LIVE-VERIFICATION.md](docs/LIVE-VERIFICATION.md) before attempting cleanup.

Scopes requested:

- Gmail read-only: `https://www.googleapis.com/auth/gmail.readonly`
- Gmail cleanup: `https://www.googleapis.com/auth/gmail.modify`
- Microsoft read-only: `Mail.Read` (plus `openid`, `profile`, `email`, `offline_access`)
- Microsoft cleanup: `Mail.ReadWrite` (same identity scopes)

MailSentry never asks for an email password and never requests Gmail's `https://mail.google.com/` full scope.

Tokens live in server memory. Restarting the server or clicking **Disconnect** removes them. Revoke provider-side grants in your Google or Microsoft account settings if desired.

---

## Using Email Health

1. Open **Email Health**.
2. Enter a public domain — not an email address, IP address, or internal hostname.
3. Optionally provide a DKIM selector from a recent `DKIM-Signature` header.
4. Press **Run DNS checks**. The request is bounded to MX and TXT lookups for that domain and selector.
5. Read findings by category. “Inconclusive” means a DNS query failed or evidence was insufficient — not that the configuration is healthy.
6. Apply changes in your DNS provider yourself. MailSentry never edits DNS.

Domains are validated before lookup. Internal names, single-label hosts, IP literals, and reserved suffixes such as `.local` and `.internal` are rejected so the feature cannot be used as an internal network scanner.

---

## Safe cleanup workflow

1. **Connect or select a provider.** Prefer read-only if you only want to scan. Cleanup access is required only for execution.
2. **Select folders.** Inbox, Spam, and Trash are independent checkboxes; initially none are selected.
3. **Choose one action.** Archive is limited to the Inbox; moving Trash to Trash is refused; Empty Trash is limited to Trash.
4. **Configure filters.** The default is older than 365 days. At least one positive criterion is required for normal cleanup, preventing accidental whole-folder selection. Starred, unread, and important messages stay protected unless explicitly included.
5. **Scan.** This is read-only and metadata-only. You see scanned/eligible counts, uncertain classifications, size estimates, per-folder totals, and a bounded sample.
6. **Review.** Read warnings and provider limitations. The preview is stored server-side with a hash and a one-time review token and expires after 20 minutes.
7. **Dry-run (optional).** Re-reads and revalidates every candidate; never mutates.
8. **Execute.** A separate confirmation dialog is shown. Permanent deletion and Empty Trash additionally require typing `DELETE PERMANENTLY`; this phrase is enforced by the HTTP gate, the core plan gate, and the executor.
9. **Review results.** Per-message state is rechecked immediately before mutation. Messages that moved, disappeared, or stopped matching are skipped. Failures and uncertain outcomes are reported separately. Cancellation stops new work but does not roll back completed changes.

What the actions mean:

- **Archive** removes the Inbox label (Gmail) or moves to the Archive folder (Microsoft); storage is not freed immediately.
- **Move to Trash** moves messages to the provider's Trash / Deleted Items; recovery depends on provider retention.
- **Permanent delete** is irreversible and provider-dependent.
- **Empty Trash** permanently deletes eligible Trash messages; filters are ignored for this action, but allowlist and protection rules still apply.

---

## Architecture

```text
Browser (vanilla TypeScript, esbuild)
   │  JSON over loopback, HttpOnly session cookie + CSRF header
   ▼
Local Node HTTP server (no framework)
   ├── session + job + plan stores (in memory, TTL bounded)
   ├── Email Health ──► DNS resolver (node:dns) ──► MX / TXT
   └── Cleanup core ──► provider adapter (Gmail / Microsoft Graph)
                         └── official OAuth + HTTPS APIs
```

Key boundaries:

- **UI** (`src/web`) handles configuration, progress, review, and confirmation only.
- **Core** (`src/core`) owns filtering, plan hashing, execution gating, batching, cancellation, and result accounting. It is testable with a synthetic provider and no UI.
- **Providers** (`src/providers`) own authentication, pagination, metadata reads, and mutations. Provider semantics are never assumed to be identical.
- **Diagnostics** (`src/diagnostics`) contains pure parsers and a bounded DNS resolver.
- **Security** (`src/security`) contains validation, redaction, logging, and session handling.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for API endpoints, plan lifecycle, threat boundaries, and design rationale.

---

## Memory and performance

MailSentry is designed to avoid loading a mailbox into memory:

- Paginated metadata retrieval (50 messages per page).
- Streaming aggregation; only message IDs/folders are retained for execution.
- A bounded preview sample (100 messages) and result sample (100 problem outcomes).
- Batched execution (25 messages) with limited concurrency (3) and provider rate limiting.
- Provider-aware timeouts, bounded retries, cancellation, and no automatic retry of ambiguous mutations.
- No unbounded caches or persistent mailbox copies.

A reproducible synthetic benchmark is included:

```bash
npm run bench
```

It runs each scenario in a separate process and records peak RSS, elapsed time, messages processed, API calls, batch/concurrency, rate-limit pacing, and cancellation behavior. Measured results and methodology are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

Latest reference run on Node 22.23.2 / AMD Ryzen 7 8700F:

| Scenario             | Messages | Eligible/processed |  Peak RSS |  Elapsed |
| -------------------- | -------: | -----------------: | --------: | -------: |
| Scan + preview       |    2,000 |              1,648 |  63.2 MiB |    24 ms |
| Scan + preview       |   30,000 |             24,739 | 126.5 MiB |   784 ms |
| Scan + dry run       |   20,000 |             16,460 | 117.2 MiB |   334 ms |
| Cancelled dry run    |    5,000 |       240 of 4,096 |  69.4 MiB |   250 ms |
| Rate-limited dry run |      300 |                251 |  55.2 MiB | 1,574 ms |

The synthetic fixture itself holds the whole mailbox in memory, so these peaks are conservative relative to the real app, which holds only one page at a time. They are not claims about provider network latency or production throughput.

---

## Security and privacy

- OAuth only; no password collection.
- Minimal scopes; Gmail full scope is never requested.
- Tokens in server memory, never in browser bundles, responses, or logs.
- No token encryption scheme is invented. Avoiding persistence avoids storing plaintext credentials.
- HttpOnly, `SameSite=Lax` session cookie; CSRF header required on mutations; Origin checks; Host-header validation to reduce DNS-rebinding risk; strict CSP and security headers.
- Loopback-only binding by default; non-loopback plain HTTP is rejected.
- Strict domain/selector validation; MX/TXT lookups only; no arbitrary URL fetching.
- Read-only scans; server-side plan hash + review token; revalidation before every mutation; typed confirmation for irreversible actions; provider capability checks.
- Credential redaction in errors and logs; no request bodies, authorization headers, subjects, or sender addresses are logged.

Known limitations and the full threat model are in [SECURITY.md](SECURITY.md). Network destinations and retention are documented in [docs/PRIVACY.md](docs/PRIVACY.md).

MailSentry is local-first, not magic: whoever controls the local machine or the unlocked browser session may be able to use a connected account until it is disconnected. Provider APIs and OAuth still see your requests. There has been no independent security audit.

---

## Testing and validation

```bash
npm test              # 167 unit + integration tests
npm run test:coverage # V8 coverage
npm run typecheck     # server and browser
npm run lint          # ESLint
npm run format:check  # Prettier
npm run build         # typecheck + server compile + browser bundle
npm audit             # dependency audit
```

Safety tests assert, among other things:

- scanning and preview never invoke mutation methods;
- dry runs never invoke mutation methods;
- folder selections are independent;
- permanent deletion requires the exact confirmation phrase at multiple layers;
- a changed plan hash, expired plan, or invalid review token cannot execute;
- moved/disappeared messages are skipped, not mutated;
- failures are not reported as successes and ambiguous outcomes are reported as uncertain;
- cancellation reports partial completion without claiming rollback;
- credentials are redacted from logs/errors;
- large scans retain a bounded sample, not full mailbox metadata.

Tests use only synthetic data and mocked HTTP. There is no test that connects to a real mailbox. See [docs/TESTING.md](docs/TESTING.md).

GitHub Actions runs typecheck, lint, formatting, tests, build, and dependency audit on every push and pull request; the workflow is in `.github/workflows/ci.yml`.

---

## Project layout

```text
src/
  core/          cleanup planning, eligibility, executor, batching, capabilities
  diagnostics/   DNS resolver, SPF/DKIM/DMARC parsers, report builder
  providers/     OAuth, token store, Gmail, Microsoft Graph, HTTP policy, synthetic provider
  security/      validation, redaction, logging
  server/        HTTP server, sessions, API routes, roadmap parser
  shared/        contracts shared by server and browser
  web/           accessible vanilla TypeScript UI and styles
  cli/           domain diagnostics CLI
  bench/         reproducible synthetic memory benchmark
tests/           unit and integration tests (synthetic only)
docs/            architecture, providers, privacy, testing, benchmarks
scripts/         web build and development runner
```

---

## Roadmap

Implementation status is tracked in [ROADMAP.md](ROADMAP.md) and shown in the app. Phase 1 is implemented modulo live provider verification. Later phases are intentionally not started.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) first. Never test destructive behavior against a real mailbox. Report security issues privately, not in a public issue.

---

## License

This repository is licensed under the **MIT License**; see [LICENSE](LICENSE) and the [licensing review](docs/LICENSING.md).

MIT is a permissive open-source license: you may use, modify, and redistribute the code, including commercially, provided the copyright and permission notice are retained. The software is provided without warranty. All runtime dependencies are absent, and the development-only dependencies use permissive licenses compatible with MIT.
