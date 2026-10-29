# Testing and Validation

MailSentry's tests are deliberately hostile about destructive behavior. They use synthetic mailboxes and mocked HTTP; **no test contacts a real mailbox, real OAuth server, or DNS provider**.

## Commands

```bash
npm test                # unit + integration tests (Vitest)
npm run test:watch      # watch mode
npm run test:coverage   # V8 coverage (text + lcov)
npm run typecheck       # server + browser TypeScript
npm run lint            # ESLint
npm run format:check    # Prettier check
npm run build           # typecheck + server compile + browser bundle
npm run bench           # synthetic memory benchmark
npm audit               # known dependency advisories
```

Latest reference run (this implementation):

| Check            | Result                               |
| ---------------- | ------------------------------------ |
| Tests            | **185 passed / 185** across 13 files |
| Statements       | 79.09%                               |
| Branches         | 67.64%                               |
| Functions        | 85.88%                               |
| Lines            | 81.55%                               |
| TypeScript       | Clean (server + browser)             |
| ESLint           | Clean                                |
| Prettier         | Clean                                |
| Production build | Success                              |
| `npm audit`      | 0 vulnerabilities                    |

Coverage is intentionally lower in OAuth token exchange/refresh, the provider manager's live paths, and the real DNS resolver because those require external services. Their pure logic and failure classification are tested; live behavior is explicitly unverified.

## Test map

| File                                      | Focus                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/validation.test.ts`           | Domain normalization/rejection, selector validation, folder/action parsing, filter bounds, action/folder semantics                                                                         |
| `tests/unit/records.test.ts`              | SPF, DMARC, and DKIM parsers: valid, missing, multiple, malformed, revoked, lookup limits                                                                                                  |
| `tests/unit/diagnostics.test.ts`          | Report orchestration with a fake DNS resolver; query count; NXDOMAIN/timeout/SERVFAIL distinction; null MX; DKIM selector requirement                                                      |
| `tests/unit/eligibility.test.ts`          | Protection defaults, allowlists/targets, age/size/attachment/bulk filters, drafts, Empty Trash bypass                                                                                      |
| `tests/unit/plan.test.ts`                 | Canonical plan hash, expiry, review token, typed confirmation, capability gate, plan consumption, sample bounds                                                                            |
| `tests/unit/security.test.ts`             | Batching, concurrency bound, cancellation of queued work, rate limiting, credential redaction, roadmap parsing                                                                             |
| `tests/unit/providers.test.ts`            | Mocked Gmail/Graph mapping, read-only refusal, Graph pagination-host rejection, HTTP 429 retry, ambiguous mutation policy, 401 mapping                                                     |
| `tests/unit/oauth-config.test.ts`         | PKCE/authorize URL construction, state generation/expiry/replay/provider mismatch, granted-scope reporting, unconfigured-provider behavior, token-store deletion, config safety validation |
| `tests/unit/connection-check.test.ts`     | Read-only folder/metadata connection check, per-folder failures, unsupported folders, cancellation, no mutations                                                                           |
| `tests/integration/cleanup.test.ts`       | Full scan → plan → dry-run/execute lifecycle, folder independence, stale/changed messages, failures, uncertainty, cancellation                                                             |
| `tests/integration/server.test.ts`        | Session cookie, CSRF, Origin, Host/DNS-rebinding, body limits, unconfigured OAuth, plan-required execution, static fallback                                                                |
| `tests/integration/desktop-oauth.test.ts` | System-browser start response, no authorize URL in desktop mode, cookie-independent callback handling, missing/unknown/replayed state, provider denial                                     |

## Required safety properties → tests

| Property                                                          | Evidence                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Scanning never invokes mutations                                  | `cleanup.test.ts` → “scans paginated messages without any mutation call”; mutation counters remain 0                             |
| Connection check never invokes mutations                          | `connection-check.test.ts`; folder probes only, mutation counters remain 0                                                       |
| Preview never invokes mutations                                   | The same test plus plan construction; no mutation path is reachable from `scanMailbox`/`PlanStore.create`                        |
| Dry-run never invokes mutations                                   | “performs revalidation reads but never mutates”; all archive/trash/delete counters 0 and mailbox IDs unchanged                   |
| Inbox cleanup does not affect spam/trash unless selected          | “does not include or modify spam/trash during an inbox scan”                                                                     |
| Selecting spam/trash does not implicitly select inbox             | “does not include the inbox when only spam is selected”                                                                          |
| Permanent deletion requires explicit authorization + confirmation | `plan.test.ts` gate tests; `cleanup.test.ts` rejects executor without phrase, then deletes only with `DELETE PERMANENTLY`        |
| Modified plan cannot execute without renewed review               | Hash mismatch test; changed message sets produce different hashes; consumed plans cannot replay                                  |
| Changed messages between preview/execution are skipped            | Moved, removed, and newly protected messages are skipped; new messages absent from the plan are untouched                        |
| Failed operations are not reported as successes                   | Injected provider failure yields `failed=1`, `succeeded=2`, and the message remains                                              |
| Ambiguous outcomes are uncertain, not retried                     | Injected ambiguous timeout yields `uncertain=1`, `failed=0`; no automatic mutation retry                                         |
| Cancellation is truthful                                          | Abort mid-run yields `cancelled=true`, processed < total, warning about in-flight work and no rollback                           |
| Credentials do not leak                                           | Redaction tests for bearer headers, query tokens, Google tokens, JWTs, sensitive keys, and error strings                         |
| Large scans remain bounded                                        | Scan retains only IDs/folders plus a ≤100 sample; benchmark measures peak RSS across 2k–30k messages                             |
| Unsupported provider operations are disabled                      | Gmail permanent delete/Empty Trash rejected; read-only adapters refuse mutations                                                 |
| Provider pagination is safe                                       | Synthetic pagination across 123 messages; Graph next-link origin validation                                                      |
| HTTP boundary is safe                                             | CSRF required; cross-origin POST rejected; unexpected Host rejected with 421; non-JSON body rejected                             |
| OAuth state is single-use and expires                             | `oauth-config.test.ts`: missing/unknown/expired/reused state rejected; consumed before exchange; provider mismatch rejected      |
| Desktop OAuth does not rely on shared cookies                     | `desktop-oauth.test.ts`: callback with missing code/replay succeeds without any cookie; start response hides URL in desktop mode |
| OAuth secrets are not exposed                                     | State/PKCE tests plus redaction tests; callback HTML contains no code/state/tokens                                               |

## Test architecture

### Synthetic provider

`src/providers/synthetic.ts` implements `MailProvider` entirely in memory. It supports:

- pagination (`pageSize`), empty folders, and arbitrary message counts;
- read-only mode and capability overrides;
- injected failures per operation/message with configurable occurrence counts;
- simulated latency and mutation delay;
- call counters and a mutation log;
- mutation of its mailbox so revalidation behavior can be tested.

It is used by tests and the benchmark only. It is not imported by the server entry point and cannot be selected in the UI, so fabricated mailbox data is never presented as real.

### Mocked transport

Provider tests replace global `fetch` with Vitest mocks and return real `Response` objects. This exercises URL construction, selected fields, headers, pagination, error mapping, and read-only refusal without network access. No access token in tests is real.

### Fake DNS

`tests/helpers/fixtures.ts` contains `FakeDnsResolver`, which records each MX/TXT call and returns configured values or classified failures. Tests assert the exact call list, so accidental extra lookups or recursion would fail.

### Server tests

`MailSentryApp` is started on an ephemeral loopback port with an isolated configuration. Tests use real HTTP against the local process, including a raw `http.request` to override the `Host` header. Provider OAuth is unconfigured, so no external authorization is attempted.

## Deliberate gaps

- **No live Gmail/Microsoft verification.** Requires user OAuth registrations and test mailboxes.
- **No OAuth token exchange/refresh integration test.** Would require mocking or contacting the providers; state/PKCE construction and failure gating are unit-tested, but live refresh behavior is unverified.
- **No real DNS integration test.** Tests use a fake resolver; manual CLI checks were run against public DNS during development.
- **No browser E2E test** (Playwright etc.). The client is type-checked and built; manual smoke testing covers navigation and key flows. Automated accessibility scanning is not included.
- **No automated OS keyring test** because keyring persistence is not implemented.
- **Memory is measured by the benchmark, not unit tests.** RSS assertions in unit tests would be flaky; the benchmark provides reproducible evidence instead.
- **No provider quota exhaustion test against real APIs.** Rate limiting/retry logic is unit-tested with mocked 429/5xx responses.

Do not describe these gaps as covered.

## Manual validation checklist

Run after changes affecting UI, OAuth, or provider behavior:

1. `npm ci && npm run build && npm start`; open `http://127.0.0.1:4310`.
2. Confirm the overview does not connect or scan automatically.
3. Run Email Health for a known domain (`google.com` is useful for configured MX/SPF/DMARC) and a deliberately invalid input (`127.0.0.1`, `localhost`).
4. Check keyboard-only navigation and visible focus; confirm errors are announced and dialogs trap focus natively.
5. Without OAuth configured, confirm Settings explains setup and no “Connect” action succeeds.
6. With a test account, connect read-only; confirm scans/dry runs work and execution is disabled.
7. Reconnect with cleanup access; verify a small reversible archive/trash batch in the provider UI.
8. For Microsoft permanent delete, use disposable messages and verify the typed phrase is required.
9. Navigate away during a job; confirm Activity reports it and no false rollback is claimed.
10. Disconnect; confirm the connection disappears. Restart the server; confirm reconnection is required.
11. Inspect browser dev tools: only same-origin assets and API requests; no analytics.
12. Confirm the console and server stderr contain no tokens, subjects, sender addresses, or message IDs.

## Dependency and secret checks

```bash
npm audit --omit=dev      # runtime dependency set is empty
npm audit
npx gitleaks detect --no-git   # if gitleaks is available
git grep -nE '(ya29\.|BEGIN (RSA |EC )?PRIVATE KEY|client_secret\s*=\s*[^ ]+)' -- . ':!package-lock.json'
```

The repository contains no `.env`, keys, tokens, or mailbox fixtures. `.env` and benchmark output are ignored.

## Windows desktop validation

The packaged Electron build was tested natively on Windows 11 Home x64 (build `10.0.26200`), not merely built in WSL:

| Check          | Procedure                                                                        | Result                                                                                |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Packaged smoke | `MailSentry.exe --smoke-test=<path>` with isolated `MAILSENTRY_USER_DATA_DIR`    | Passed; renderer heading, six nav items, `/api/status`, Electron 45.1.0, Node 24.22.1 |
| Normal launch  | Started `win-unpacked\MailSentry.exe`; polled `http://127.0.0.1:4310/api/status` | Passed                                                                                |
| Clean shutdown | Sent `CloseMainWindow()`; waited for exit                                        | Exit 0; no orphan `MailSentry.exe`                                                    |
| Relaunch       | Started/closed a second time with same user data                                 | Passed                                                                                |
| Persistence    | Inspected user-data folder                                                       | `.env.example`, `window-state.json`, redacted log present                             |
| Port conflict  | Bound 4310 with a TCP listener, then launched smoke build                        | Exit 1 with `EADDRINUSE`; no orphan                                                   |
| Portable EXE   | Ran `MailSentry-Portable-0.1.0-x64.exe` smoke                                    | Passed                                                                                |
| NSIS installer | Built natively; not installed                                                    | Build succeeded; install/upgrade/uninstall unverified                                 |

The Linux/WSL host could not normally launch Electron due missing GUI libraries, and NSIS builds there fail without Wine; the native Windows build host was used for runtime and installer validation. Browser cookies/tokens were not inspected; the app uses an in-memory session partition and clears storage at startup.

## Benchmark

See [BENCHMARKS.md](BENCHMARKS.md). Commands:

```bash
npm run bench
# results are written to bench/results/latest.json (ignored by Git)
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests:

- Linux: locked install, typecheck, ESLint, Prettier check, unit/integration tests, production build, and dependency audit.
- Windows: locked install and a Windows `win-unpacked` desktop build. No artifacts are uploaded.

The workflow has read-only repository permissions and does not deploy, publish, or access provider credentials. It is not a substitute for live provider verification or an independent security review.
