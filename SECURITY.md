# Security Policy

MailSentry handles OAuth credentials and can perform destructive mailbox operations. Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting / Security Advisories for `retrac-ca/mailsentry`:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include affected version or commit, reproduction steps, impact, and any suggested fix.
4. Do not include real access tokens, refresh tokens, client secrets, mailbox contents, or personal data. Redact them.

If private reporting is unavailable, open a minimal public issue asking for a private channel — without technical details.

### What to expect

- Acknowledgement is best-effort by the maintainers; this is a small open-source project.
- Confirmed issues will be fixed on the current branch and documented in the release notes.
- Please allow reasonable time for a fix before public disclosure.
- Credit is offered unless you prefer to remain anonymous.

No bug bounty or paid program is offered.

## Supported versions

| Version               | Supported                          |
| --------------------- | ---------------------------------- |
| `0.1.x` (current MVP) | Security fixes as capacity permits |
| Older / forks         | Not supported                      |

The project has **not** undergone an independent security audit. Do not assume audit-grade assurance.

## Security assumptions

MailSentry assumes:

1. It runs on a machine controlled by the user, bound to loopback.
2. The local operating system account and browser profile are trusted. Malware or another local user with access to the session can act as the user while a provider is connected.
3. The user registers their own OAuth client and protects its client secret.
4. The user reviews the preview and confirmation dialogs; the server still enforces plan integrity, capability checks, and typed confirmation independently of the UI.
5. Provider APIs, DNS resolvers, and TLS are not compromised.
6. The browser is current and honors CSP, `HttpOnly`, and `SameSite`.
7. The application is not exposed directly to the public internet. A non-loopback bind requires an explicit opt-in and is outside the supported threat model.
8. The Windows desktop shell loads only the loopback UI with Node disabled and a sandboxed renderer; navigation is restricted to the app origin and OAuth provider hosts.

## Threat model and controls

| Threat                                        | Impact                                     | Controls                                                                                                                                                                                     | Residual risk                                                           |
| --------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Accidental whole-folder deletion              | Data loss                                  | No default folder/action; at least one positive filter required; protections on by default; preview counts; dry run; typed confirmation for irreversible actions                             | A user can still deliberately confirm a broad plan                      |
| Stale preview executes different mail         | Deleting messages the user did not review  | Plan hash binds provider, folders, filters, action, and exact message IDs; per-message revalidation and folder check before mutation; new messages never enter an existing plan              | Provider eventual consistency can briefly hide changes                  |
| Forged/cross-site request                     | Unauthorized cleanup                       | Random session ID; CSRF token required on POST; Origin check; `SameSite=Lax`; strict CSP; no CORS                                                                                            | Compromised local browser or same-origin XSS                            |
| DNS rebinding                                 | Attacker-controlled page reaches local API | Host-header validation against configured base URL; loopback binding; Origin + CSRF checks                                                                                                   | Misconfigured `MAILSENTRY_ALLOW_NONLOCAL` expands exposure              |
| OAuth token theft                             | Account access                             | PKCE; state bound to session and single-use; tokens only in server memory; never in browser responses; redacted logs                                                                         | Local process memory inspection, compromised host, malicious dependency |
| OAuth authorization code interception         | Account access                             | PKCE verifier; short-lived state; exact redirect URI; state/session binding                                                                                                                  | Provider-side compromise                                                |
| Secret leakage in logs/errors                 | Credential exposure                        | Central redaction of bearer tokens, token parameters, Google tokens, JWTs, and sensitive object keys; no request bodies or authorization headers logged                                      | Unknown token formats may escape the pattern list                       |
| SSRF / internal scanning                      | Network reconnaissance                     | Domain validation rejects IPs, single-label names, and reserved suffixes; DNS uses only MX/TXT; no URL fetching from diagnostics; Graph pagination links restricted to `graph.microsoft.com` | DNS queries still reveal the queried name to the local resolver         |
| Malicious mailbox metadata (subjects/senders) | Stored XSS                                 | All UI content rendered with `textContent`/DOM nodes; no untrusted `innerHTML`; strict CSP without `unsafe-inline`                                                                           | Browser or DOM-library bugs                                             |
| Desktop renderer loading remote content       | Token/API abuse or UI spoofing             | Sandboxed renderer, Node disabled, no preload/IPC, navigation restricted to local origin + OAuth hosts, permissions/webviews denied, external links open in system browser                   | OAuth provider pages themselves; live flow unverified                   |
| Provider failure reported as success          | False confidence / loss                    | Mutations classified as confirmed success, confirmed failure, changed, or uncertain; ambiguous network failures never retried; partial results reported                                      | Provider may report success before durable consistency                  |
| Runaway resource consumption                  | Denial of service / local freeze           | Pagination, 50k scan bound by default, bounded preview/result samples, 25-message batches, concurrency 3, rate limiting, timeouts, cancellation                                              | Very large mailboxes still take time; in-memory IDs scale linearly      |
| Dependency compromise                         | Code execution / exfiltration              | Zero runtime dependencies; small pinned dev dependency set; lockfile; `npm audit`                                                                                                            | Development-tool supply chain remains a risk                            |
| Credential persistence at rest                | Token theft from disk                      | No persistence. No “custom encryption” scheme. Tokens disappear on restart/disconnect                                                                                                        | Users must reconnect after restart                                      |

## Destructive-operation safety model

These rules are enforced in the core and provider layers, not only in the UI:

1. **Scanning never modifies messages.** Scan calls only list/metadata reads. Tests assert zero mutation calls.
2. **Preview generation never modifies messages.** Plans are built from scan results; no provider write is reachable from that path.
3. **Dry-run never modifies messages.** The executor performs revalidation reads and reports simulated success without calling mutation methods.
4. **Page load never triggers work.** There is no auto-connect, auto-scan, auto-cleanup, or scheduled worker.
5. **Permanent deletion requires explicit authorization.** The HTTP gate, plan gate, and executor require the exact phrase `DELETE PERMANENTLY`.
6. **Folders and action must match the reviewed plan.** The plan hash binds provider, folders, filters, action, and message IDs; action/folder combinations with unsafe semantics are rejected.
7. **Stale previews cannot execute.** Plans expire after 20 minutes, are consumed before execution, and are rejected if the hash or one-time review token does not match.
8. **Provider failure is never success.** Only a completed provider call is counted as succeeded. Failures, skips, and uncertain outcomes have separate counters and samples.
9. **Ambiguous outcomes are reported as uncertain.** Timeouts/network failures after a mutation are marked uncertain and are not automatically retried.
10. **Retries respect idempotency.** Reads retry bounded transient failures; explicit 429 responses may be retried; ambiguous mutation failures are not.
11. **Cancellation does not imply rollback.** The UI and job warnings state that in-flight work may have completed and completed changes remain.
12. **Tests never touch real mailboxes.** All automated tests use synthetic in-memory providers and mocked HTTP.

Provider-level defenses:

- A read-only connection refuses mutations inside the adapter, even if a caller bypasses the UI.
- Unsupported actions are rejected by capability checks before a job can start.
- Gmail permanent delete/empty trash are not implemented because they require a scope MailSentry refuses to request.
- Microsoft Graph pagination is constrained to `https://graph.microsoft.com/v1.0/`.

## Credential handling

- MailSentry never requests an email password.
- OAuth uses authorization code + PKCE and a single-use `state` value bound to the browser session.
- Tokens are stored in a process-memory `Map`, keyed by an unguessable session cookie value. They are not returned by any API, written to disk, or logged.
- Access tokens are refreshed server-side when near expiry. Refresh failures delete the local connection and require reconnection.
- Disconnect removes local tokens immediately. Restarting the process discards all tokens.
- Provider-side revocation must be performed at Google or Microsoft; local disconnect cannot revoke a grant at the provider.
- MailSentry does not implement token encryption. It deliberately avoids persistence rather than inventing an encryption scheme. OS keyring integration is future work and blocked until it can be done with a maintained platform facility.

## Local HTTP security

- Default bind: `127.0.0.1`.
- Non-loopback plain HTTP is rejected by configuration validation. Non-loopback binding requires `MAILSENTRY_ALLOW_NONLOCAL=true`, which is outside the supported model.
- Session cookie: random 256-bit ID, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the base URL is HTTPS; no persistent expiry (server TTL 8 hours).
- All mutating requests require a per-session CSRF token in `x-csrf-token`; tokens are compared in constant time.
- Origin, when present, must match the configured origin (or a loopback alias with the same port).
- Host must match the configured host and port; other hosts receive HTTP 421.
- CSP: `default-src 'self'`; no inline scripts, no third-party assets, no remote fonts; `frame-ancestors 'none'`.
- API bodies are capped at 32 KiB and must be JSON.
- No CORS headers are emitted.
- Sessions, plans, diagnostics, and jobs are bounded and expire. There is no database.

## DNS and network restrictions

Email Health accepts a public domain and an optional DKIM selector only. It rejects IP literals, single-label names, internal/reserved suffixes, and characters that could form URLs or host lists. It performs at most four logical lookups per check (MX, SPF TXT, DMARC TXT, and optional DKIM TXT) with timeouts. It never follows arbitrary URLs, performs AXFR, or recursively resolves SPF includes.

Provider integrations contact only documented Google/Microsoft OAuth and mail APIs over HTTPS. The only other automatic destination is the operating system's configured DNS resolver. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Data retention

In-memory per session, discarded on restart or session expiry (8 hours idle):

- Session ID and CSRF token.
- Up to 5 diagnostic reports (domain, findings, observations, limitations).
- Up to 20 cleanup job summaries, including bounded samples of subjects/senders for problem outcomes.
- Up to 3 unreviewed/expired cleanup plans; plans contain message IDs, folders, filters, and a bounded preview sample. Plans are bound to the creating session and to the exact provider connection/mode.

Not stored: message bodies, attachments, full mailbox listings, access/refresh tokens on disk, analytics events.

Application logs to stderr include domains, providers, actions, and aggregate counts. They intentionally omit tokens, authorization headers, subjects, sender addresses, and message IDs. Log retention is whatever the operator's terminal/service does with stderr.

## Known limitations and unresolved risks

- No independent security audit.
- No live verification of Gmail or Microsoft Graph behavior in this repository, including the Electron in-window OAuth flow.
- The Windows installer/portable build is unsigned; installer installation, upgrade, and uninstall have not been tested.
- No Windows auto-update mechanism; users must obtain new builds manually.
- Electron/Chromium adds a large runtime attack surface compared with the headless server; the renderer is sandboxed, but dependency and Chromium updates remain required.
- Provider semantics and retention policies vary; MailSentry cannot guarantee what “Trash” means or that recovery is possible.
- Gmail permanent delete/empty trash requires a scope that is intentionally not requested.
- Attachment-size filtering is unavailable because list metadata does not expose reliable sizes.
- Token storage is memory-only; there is no OS keyring integration.
- OAuth client secrets are read from environment variables; protection of `.env` and the process environment is the operator's responsibility.
- Local malware, browser extensions, or a shared unlocked machine can act within the authenticated session.
- DNS results can be cached or transiently wrong; an “inconclusive” result is not a clean bill of health.
- SPF analysis does not recursively resolve includes or macros, so lookup counts are lower bounds.
- DMARC subdomain inheritance is not resolved.
- The benchmark is synthetic and does not model provider latency or quota behavior.
- A hard process crash (power loss, `kill -9`, OOM) during execution cannot produce an in-process report. Provider operations already sent may have completed; verify the mailbox before retrying. Graceful cancellation does report partial results.
- Dependency auditing covers known advisories only; it cannot prove absence of compromise.
- The repository is licensed under MIT; this is a legal/compatibility matter, not a security control.

## Dependency and supply-chain posture

- **Runtime dependencies: none.** The server uses Node built-ins; the browser bundle is hand-written TypeScript.
- Development dependencies are pinned exactly and locked in `package-lock.json`.
- `npm audit` is run during validation. Current result at implementation time: 0 known vulnerabilities (see the final report).
- Run `npm audit --omit=dev` before release to confirm the empty runtime dependency set.
- Useful additional checks (not bundled as dependencies): `npx gitleaks detect --no-git`, repository secret scanning, and `npm audit signatures`.

## Safe research guidance

- Use synthetic fixtures and test accounts.
- Never run mutation tests against a real mailbox.
- Never include live tokens in reports, screenshots, or logs.
- Do not probe third-party domains in ways that exceed ordinary public DNS queries.
