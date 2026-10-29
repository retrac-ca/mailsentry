# Architecture

MailSentry is a single-process, local-first TypeScript application. It has no database, queue, background worker, or cloud component. The same process serves the browser UI, runs DNS diagnostics, holds OAuth sessions, and executes reviewed cleanup jobs.

## Design goals

1. **Make destructive behavior hard to trigger accidentally.** The server, not the dialog, owns plan integrity and confirmation.
2. **Treat mailbox memory as a scarce resource.** Process metadata page by page; retain IDs and small bounded samples.
3. **Keep provider semantics explicit.** Gmail and Microsoft differ in folders, scopes, deletion, and archival; the capability model must say so.
4. **Stay auditable.** Small dependency surface, readable modules, pure parsers, and tests that demonstrate safety properties.
5. **Be honest.** Inconclusive diagnostics, unavailable operations, unverified integrations, and partial failures are labeled.

## Technology choices

| Choice                       | Rationale                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------- |
| TypeScript (strict, ESM)     | Type contracts across server/browser; catches provider and plan-shape errors     |
| Node.js 22 built-in HTTP     | One dependency-free server; routing needs are small                              |
| Vanilla TypeScript + esbuild | Six views, no client state graph, no framework runtime; bundle ≈88 KB unminified |
| `node:dns/promises`          | Bounded MX/TXT lookups without a DNS library                                     |
| Native `fetch`               | OAuth and provider HTTP without an SDK or runtime dependency                     |
| In-memory stores             | No persistence of credentials or mailbox metadata; simplest safe MVP             |
| Vitest                       | Fast unit/integration tests with mocked `fetch` and synthetic provider           |
| Zero runtime dependencies    | Smaller supply-chain and license surface                                         |

Rejected for the MVP: React/Next (unnecessary runtime), Express/Fastify (tiny routing surface), databases/ORMs (conflicting retention and simplicity goals), Redis/queues (no background processing), provider SDKs (large surface; direct documented REST endpoints are sufficient), Electron (not needed for a localhost app).

## Component map

```text
┌──────────────────────────── Browser (src/web) ────────────────────────────┐
│ hash router · views · API client · DOM helpers · no secrets              │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ JSON + HttpOnly session cookie + CSRF header
┌───────────────────────────────▼───────────────────────────────────────────┐
│ HTTP server (src/server)                                                  │
│  app.ts routes · session store · static assets · roadmap · activity       │
│  security: Host/Origin/CSRF checks · CSP · body limits · rate limiting    │
└───────┬──────────────────────────────┬────────────────────────────┬───────┘
        │                              │                            │
┌───────▼──────────────┐   ┌───────────▼─────────────┐   ┌──────────▼───────┐
│ Diagnostics           │   │ Cleanup core            │   │ Provider manager │
│ (src/diagnostics)     │   │ (src/core)              │   │ (src/providers)  │
│ DNS adapter           │   │ eligibility             │   │ OAuth + PKCE     │
│ SPF/DKIM/DMARC parsers│   │ scan aggregation        │   │ token store      │
│ finding/report builder│   │ plan store + hash gate  │   │ Gmail adapter    │
└───────┬───────────────┘   │ executor (batch/cancel) │   │ Graph adapter    │
        │                   │ batch/rate primitives   │   │ HTTP policy      │
        ▼                   └───────────┬─────────────┘   └──────────┬───────┘
   System DNS                         │                             │
   (MX/TXT only)                      ▼                             ▼
                              Synthetic/test seam          Google / Microsoft APIs
```

## Module responsibilities

| Path                           | Responsibility                                                  |
| ------------------------------ | --------------------------------------------------------------- |
| `src/shared/types.ts`          | Cross-boundary contracts; no secrets, no provider logic         |
| `src/core/config.ts`           | Environment loading and loopback/base-URL validation            |
| `src/core/capabilities.ts`     | Provider capability matrix and action semantics                 |
| `src/core/eligibility.ts`      | Pure filter/protection evaluation and sender matching           |
| `src/core/scan.ts`             | Paginated, read-only aggregation; action/folder validation      |
| `src/core/plan.ts`             | Plan hash, TTL store, review token, execution gate              |
| `src/core/executor.ts`         | Per-message revalidation, bounded execution, outcomes           |
| `src/core/batch.ts`            | Chunking, token bucket, bounded-concurrency helper              |
| `src/diagnostics/*`            | DNS adapter and pure SPF/DMARC/DKIM analysis                    |
| `src/providers/provider.ts`    | `MailProvider` interface and folder types                       |
| `src/providers/oauth.ts`       | Google/Microsoft authorization-code + PKCE clients              |
| `src/providers/token-store.ts` | Memory-only connection/token map                                |
| `src/providers/manager.ts`     | OAuth state, refresh, status, adapter construction              |
| `src/providers/gmail.ts`       | Gmail REST metadata/mutations and capability enforcement        |
| `src/providers/microsoft.ts`   | Graph metadata/mutations, folder mapping, pagination validation |
| `src/providers/http.ts`        | Timeouts, pacing, bounded retries, error classification         |
| `src/providers/synthetic.ts`   | In-memory test/benchmark provider (never registered in the app) |
| `src/security/validation.ts`   | Domain/selector/folder/filter/sender validation                 |
| `src/security/redact.ts`       | Credential-safe strings/objects/errors                          |
| `src/server/app.ts`            | HTTP routing, sessions, API, OAuth callback, job lifecycle      |
| `src/server/session.ts`        | Session and bounded job/diagnostic retention                    |
| `src/web/*`                    | Accessible UI; no provider credentials or business logic        |

## Diagnostics flow

1. `POST /api/diagnostics` validates the session, CSRF token, body, domain, and selector.
2. A small per-session rate limiter applies backpressure to repeated checks.
3. `runDiagnostics` normalizes the domain again (defense in depth) and performs at most:
   - `resolveMx(domain)`
   - `resolveTxt(domain)`
   - `resolveTxt(_dmarc.domain)`
   - optional `resolveTxt(selector._domainkey.domain)`
4. Each DNS result is either a value or a classified failure (`NXDOMAIN`, `NO_DATA`, `TIMEOUT`, `SERVFAIL`, `REFUSED`, `NETWORK`, `UNKNOWN`).
5. Pure parsers produce findings with severity, observed evidence, rationale, remediation, and confidence. Report status is `ok`, `partial`, or `failed`.
6. The report is retained in session memory (last 5) and returned with limitations. No DNS changes occur.

There is no arbitrary URL fetch, no recursion through SPF includes, and no DKIM selector guessing.

## Cleanup lifecycle

### 1. Scan (read-only)

`scanMailbox` iterates selected folders page by page via `MailProvider.listMessages`. Each message is evaluated by `evaluateEligibility`. Counts are aggregated incrementally. The result contains:

- `entries: {id, folder}[]` — the exact candidates, no subjects/bodies;
- per-folder counts and byte sums;
- at most 100 sample rows (eligible and uncertain);
- warnings and provider limitations.

The scan has a hard message bound (default 50,000). The browser can abort; the server's response-close handler aborts the scan signal.

### 2. Preview plan

`PlanStore.create` computes a SHA-256 plan hash over the canonical provider, folders, filters, action, and sorted message IDs/folders. It generates:

- `planId` (random),
- `planHash` (stable canonical hash),
- `reviewToken` (random 256-bit, one-time),
- `expiresAt` (20 minutes by default).

The full entry list stays server-side. The preview returned to the browser includes counts, sample metadata, warnings, limitations, hash, and review token. Plans are capped at 3, pruned by expiry, and bound to the creating session and the exact provider connection instance (including access mode) captured at scan time. A different session or a reconnect cannot execute the old plan.

### 3. Execution gate

`assertExecutionAllowed` (core) checks, in order:

1. plan exists and is not expired;
2. request plan hash equals the stored hash (otherwise “plan changed, review again”);
3. review token matches in constant time;
4. provider supports the action;
5. for irreversible actions in `execute` mode, the confirmation phrase is exactly `DELETE PERMANENTLY`.

The HTTP handler also checks that the request provider matches the plan and that no other job is running in the session. A plan is consumed (`take`) only for real execution after provider access succeeds. Dry-run leaves the plan intact. Replaying a consumed plan fails.

The executor repeats the action-capability and confirmation checks as defense in depth.

### 4. Dry-run

`executeCleanup` performs the same per-message revalidation reads as a real run but calls no mutation method. Success counts are explicitly simulated and storage recovery is zero. This separation is covered by tests against a mutation-counting synthetic provider.

### 5. Execute

For each batch (25 messages):

1. Check cancellation/fatal state.
2. Run up to 3 workers.
3. For each ID, `getMessage` re-reads metadata.
4. Missing message → skipped (changed).
5. Folder mismatch → skipped (moved).
6. Re-evaluate filters/protections → skipped if no longer eligible.
7. Call the provider mutation once.
8. Classify the result: succeeded, failed, skipped, or uncertain.
9. Emit progress after the batch.

No automatic retry occurs in the executor. The provider HTTP layer retries reads on transient failures and retries explicit `429` responses for any request (safe because the request was rejected), but never retries a mutation after an ambiguous network failure or 5xx. Such outcomes are marked uncertain. Authorization/permission failures stop the job.

Cancellation aborts new work and in-flight requests; in-flight mutations are reported as uncertain because the provider may have completed them. Completed changes are never described as rolled back.

### 6. Results

Job state is kept in session memory: status, processed/succeeded/failed/skipped/uncertain counts, recovered bytes, bounded problem samples, warnings, and error. The browser polls every second while running, can cancel, and can leave the page; the job continues in-process and appears in Activity.

## Provider interface

```ts
interface MailProvider {
  id: "gmail" | "microsoft";
  account: string | null;
  capabilities: ProviderCapabilities;
  mode: "readonly" | "cleanup";
  listMessages(folder, pageToken, signal): Promise<ProviderPage>;
  getMessage(id, signal): Promise<MessageMetadata | null>;
  archive(id, signal): Promise<void>;
  moveToTrash(id, signal): Promise<void>;
  permanentlyDelete(id, signal): Promise<void>;
}
```

Rules:

- `listMessages` and `getMessage` must never mutate.
- Adapters refuse mutations when `mode === "readonly"`, independently of the UI.
- Unsupported operations throw rather than approximating with a different operation.
- Provider failures map to `ProviderError` with `code`, `status`, `retryable`, `ambiguous`, `notFound`, and optional `retryAfterMs`.
- Pagination tokens are opaque; Graph next-links are validated to the Graph origin.

Capabilities are declared in `src/core/capabilities.ts` and shown in the UI. Notable differences:

- Gmail archive removes `INBOX`; Graph archive moves to the `archive` folder (error if absent).
- Gmail permanent delete/empty trash require a scope that MailSentry refuses to request.
- Graph permanent delete uses `permanentDelete`; move-to-trash uses the `deleteditems` folder.
- Neither provider exposes reliable attachment sizes in list metadata, so that filter is disabled.
- Gmail metadata can include List-* headers for bulk classification; Graph integration does not request header collections, so its bulk classification is only a sender heuristic and always “possible” (excluded when the bulk filter is on).

## Authentication and sessions

- Browser obtains an unguessable session ID cookie from `GET /api/status`.
- Cookie is `HttpOnly`, `SameSite=Lax` (so the OAuth redirect back can carry it), and `Secure` when HTTPS.
- CSRF token is delivered only in the status JSON and required on every POST.
- OAuth state is random, stored server-side, bound to session + provider + mode, expires in 10 minutes, and is single-use.
- PKCE verifier/challenge use S256.
- Google tokens come from `oauth2.googleapis.com`; Graph tokens from `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`.
- Refresh happens server-side with a per-connection lock. Failure deletes the connection and requires reconnection.
- Tokens never appear in provider status responses, the browser bundle, logs, or error messages.
- Account identity: Gmail profile API (read scope); Microsoft `id_token` decoded for display only (received directly from the token endpoint over TLS).

Read-only vs cleanup mode is chosen before authorization. A read-only connection cannot execute changes; the user must reconnect with the additional scope.

## HTTP API

All routes are same-origin; no CORS. Mutations require `x-csrf-token`.

| Method | Route                            | Purpose                                                                |
| ------ | -------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/status`                    | Session creation, CSRF token, provider status, activity, privacy notes |
| GET    | `/api/activity`                  | Session activity summaries                                             |
| GET    | `/api/roadmap`                   | Parsed `ROADMAP.md` sections/statuses                                  |
| POST   | `/api/diagnostics`               | Run bounded MX/TXT diagnostics                                         |
| POST   | `/api/auth/:provider/start`      | Create OAuth authorize URL (mode: readonly/cleanup)                    |
| POST   | `/api/auth/:provider/disconnect` | Delete local tokens                                                    |
| GET    | `/auth/:provider/callback`       | OAuth authorization-code callback                                      |
| POST   | `/api/cleanup/scan`              | Read-only scan → preview plan                                          |
| POST   | `/api/cleanup/execute`           | Gate + start dry-run/execute job (HTTP 202)                            |
| GET    | `/api/cleanup/jobs/:id`          | Job progress/results                                                   |
| POST   | `/api/cleanup/jobs/:id/cancel`   | Request cancellation                                                   |
| GET    | `/*`                             | Static browser bundle (strict allowlist; no directory listing)         |

Error shape:

```json
{ "error": { "code": "VALIDATION", "message": "…" } }
```

Codes include `VALIDATION`, `UNAUTHORIZED`, `NOT_CONFIGURED`, `NOT_CONNECTED`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, `RATE_LIMITED`, `PROVIDER_ERROR`, `CANCELLED`, `INTERNAL`.

## Memory model and bounds

| Bound                     | Default                          |
| ------------------------- | -------------------------------- |
| Scan messages per request | 50,000                           |
| Provider page size        | 50                               |
| Preview sample            | 100                              |
| Problem result sample     | 100                              |
| Execution batch           | 25                               |
| Execution concurrency     | 3                                |
| Plan TTL                  | 20 minutes                       |
| Plans retained            | 3                                |
| Jobs retained per session | 20                               |
| Diagnostics retained      | 5                                |
| Sessions                  | 200                              |
| Session idle TTL          | 8 hours                          |
| Provider read timeout     | 20 s (OAuth token exchange 15 s) |
| Gmail pacing              | 20 req/s, burst 20               |
| Microsoft pacing          | 10 req/s, burst 10               |

Only message IDs, folders, counts, and bounded samples are retained. No body or attachment is ever requested. Jobs and plans are memory-only and disappear on restart.

## Testing seams

- `DnsResolver` can be replaced with a fake; parsers are pure.
- `MailProvider` can be replaced with `SyntheticProvider`, which records read/mutation calls, supports pagination, injected failures, latency, and read-only mode.
- Provider `fetch` is replaced with Vitest mocks; no network is used in tests.
- `PlanStore` accepts an injected clock for expiry tests.
- `executeCleanup` accepts an injected clock, signal, batch/concurrency settings, and progress callback.
- Server tests use an ephemeral loopback port and synthetic sessions; no real OAuth or mailbox is contacted.

## Deployment model

Supported: `npm run build && npm start` on a local machine, opened at `http://127.0.0.1:4310`. Unsupported: multi-user hosting, public exposure, containers without loopback isolation, TLS termination without an explicit HTTPS base URL. A non-loopback bind requires an explicit opt-in and is not covered by the security model.

## Future extension points

- Additional providers implement `MailProvider`; capabilities must be declared and unsupported operations disabled.
- OS keyring credential persistence would replace the in-memory store only after a maintained platform facility is chosen and documented.
- Saved presets/reports would require a deliberate persistence/privacy design, not an ad-hoc database.
- Recursive SPF evaluation needs strict depth/query bounds and must remain opt-in.
