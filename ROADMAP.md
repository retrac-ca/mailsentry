# MailSentry Roadmap

This file is the source of truth for the in-app Roadmap view. Markers:

- `[x]` complete
- `[~]` in progress / implemented but not yet proven in the target environment
- `[!]` blocked
- `[ ]` planned

Statuses describe this repository, not intentions. Live provider verification and an independent security audit have **not** happened.

## Phase 1 — Secure MVP

- [x] Public DNS diagnostics for MX, SPF, DKIM, and DMARC with severity, evidence, rationale, remediation, and confidence labels
- [x] Bounded DNS resolver with distinct NXDOMAIN, timeout, SERVFAIL, refusal, and network handling
- [x] Domain, DKIM selector, folder, filter, and confirmation validation
- [x] Provider abstraction with explicit capability model and provider-specific deletion semantics
- [~] Gmail OAuth (PKCE), metadata pagination, archive, and move-to-trash adapter — implemented and mocked-tested; live verification needs a Google OAuth client
- [~] Microsoft 365 / Outlook OAuth (PKCE), metadata pagination, archive, move-to-trash, permanent delete, and empty-trash adapter — implemented and mocked-tested; live verification needs an Entra ID app
- [x] Independent Inbox / Spam / Trash selection with no default selection
- [x] Inbox cleanup filters: age, message size, newsletter/bulk heuristic, targeted senders, never-clean allowlist
- [x] Starred, unread, and important protection defaults with explicit opt-in overrides
- [x] Read-only paginated scan and bounded preview with per-folder counts, size estimates, uncertain counts, and sample rows
- [x] Server-held plan hash and one-time review token; stale, changed, expired, or replayed plans are rejected
- [x] Per-message revalidation immediately before mutation; moved/disappeared messages are skipped
- [x] Dry-run execution that never calls a mutation method
- [x] Explicit execution confirmation; typed `DELETE PERMANENTLY` phrase for permanent delete and Empty Trash, enforced in HTTP gate, core, and executor
- [x] Bounded batches (25), limited concurrency (3), provider rate limiting, timeouts, and cancellation
- [x] Partial-failure, uncertain-outcome, and cancellation reporting without false success claims
- [x] In-memory credential and session storage; disconnect and restart clearing behavior
- [x] CSRF, Origin, Host-header, CSP, and loopback protections
- [x] Credential redaction and metadata-only logging
- [x] Automated safety tests using synthetic mailboxes and mocked HTTP only
- [x] Reproducible synthetic memory benchmark across 2k–30k messages, including rate limiting and cancellation
- [x] Architecture, provider, privacy, security, testing, and benchmark documentation
- [!] Live Gmail and Microsoft verification — blocked on user-supplied OAuth registrations and test accounts
- [ ] Independent third-party security audit

## Phase 2 — Smarter cleanup

- [~] Newsletter identification v1 (Gmail mailing-list headers + conservative sender heuristic; uncertain matches excluded)
- [ ] Additional filters: attachment presence, sender frequency, age bands, and per-folder rules
- [ ] Conservative duplicate detection that never deletes automatically
- [ ] Saved sender rules and reusable cleanup presets
- [ ] Better storage estimates using provider quota data where available
- [ ] Exportable CSV/JSON cleanup reports with explicit privacy controls
- [ ] Expanded provider-neutral bulk classification

## Phase 3 — Advanced diagnostics

- [ ] Safer DKIM selector discovery from user-supplied signed-message headers (no mailbox-wide guessing)
- [ ] Recursive SPF include/redirect evaluation with hard query and depth budgets
- [ ] Organizational-domain DMARC inheritance checks with public-suffix awareness
- [ ] Additional records: MTA-STS, TLS-RPT, BIMI, and DNSSEC posture
- [ ] Optional authorized deliverability tests, strictly opt-in and clearly labeled
- [ ] Additional provider adapters (for example Fastmail, Proton Bridge, generic IMAP with explicit limitations)
- [ ] Historical diagnostic comparisons without retaining unnecessary mailbox data

## Phase 4 — Optional operational features

- [ ] Opt-in scheduled diagnostics while the local app is running
- [ ] Opt-in scheduled cleanup with mandatory preview windows (never silent deletion)
- [ ] Local notifications for completed operations
- [ ] Additional localization and accessibility improvements
- [ ] Carefully scoped RETRAC ecosystem integrations

## Known limitations and blocked work

- [!] Attachment-size filtering is blocked for both current providers because their list APIs do not expose reliable per-attachment sizes. MailSentry will not guess; the capability is modeled and disabled.
- [!] Gmail permanent delete and Empty Trash remain disabled because MailSentry refuses to request the `https://mail.google.com/` full-mailbox scope.
- [!] Microsoft archive requires an Archive folder; mailboxes without one receive a clear runtime error instead of a fallback.
- [!] Live provider verification is blocked on external credentials and test accounts.
- [!] Token encryption at rest is not implemented. Credentials are memory-only by design; safe platform-keyring storage would be required before adding persistence.
