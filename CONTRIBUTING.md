# Contributing to MailSentry

Thanks for helping improve MailSentry. This project handles credentials and destructive mailbox operations, so contributions are reviewed with safety and maintainability first.

By participating, you agree to be respectful and constructive. Harassment or disclosure of another person's private data is not acceptable.

## Before you start

1. Read [README.md](README.md), [SECURITY.md](SECURITY.md), and [ROADMAP.md](ROADMAP.md).
2. Check whether the change is already planned or discussed. For large changes, open an issue describing the design and safety implications first.
3. **Never** test against a real mailbox. Use synthetic fixtures or mocked HTTP.
4. **Never** commit credentials, `.env` files, tokens, mailbox contents, or screenshots containing personal data.

Security vulnerabilities must be reported privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Development setup

```bash
git clone https://github.com/retrac-ca/mailsentry.git
cd mailsentry
npm ci
cp .env.example .env
npm run dev
```

Required: Node.js **22.x** (pinned to 22.23.2 in `.nvmrc`) and npm 10+. No database or container runtime is needed.

Before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm audit
```

## Project conventions

- TypeScript in strict mode, ESM, `.js` extensions in relative imports.
- Server and tests run on Node built-ins; browser code is bundled with esbuild.
- Keep runtime dependencies at zero unless a dependency is clearly justified in the pull request. Prefer Node built-ins and small focused code.
- Pin dev dependencies exactly and keep `package-lock.json` updated.
- Follow the existing formatting (Prettier) and naming style.
- Keep changes focused. Do not mix refactors with behavior changes unless the refactor is necessary for the fix.

### Boundaries

- `src/core` must not import HTTP server code or provider SDKs. It owns eligibility, plans, execution, batching, and result accounting.
- `src/providers` owns authentication, pagination, metadata reads, and mutations. Provider-specific semantics stay behind the `MailProvider` interface.
- `src/diagnostics` stays pure/parsing-first. DNS access goes through `DnsResolver`.
- `src/server` owns HTTP, sessions, validation, and route wiring.
- `src/web` renders state and calls the local API. It must not implement safety decisions as its only enforcement.
- `src/shared` contains contracts with no secrets and no provider logic.

## Desktop / packaging

Requirements: Node.js 22.x, npm 10+, and a working desktop environment. Windows packaging is verified on Windows 11 x64; NSIS from Linux/WSL requires Wine.

```bash
npm run build
npm run desktop                 # Electron window (requires a display)
npm run dist:win                # Windows NSIS installer + portable executable
npm run dist:win:dir            # unpacked Windows app only
```

Do not commit `release/`. Do not claim the unsigned artifacts are signed. See [docs/WINDOWS.md](docs/WINDOWS.md).

## Safety invariants (mandatory)

Pull requests that touch cleanup, providers, or execution must preserve these and add tests when behavior changes:

1. Scanning is read-only.
2. Preview generation is read-only.
3. Dry-run never calls a mutation method.
4. Page load never starts a scan or cleanup.
5. Folders are independent and none are selected by default.
6. Starred, unread, and important messages are protected by default.
7. At least one positive filter is required for normal cleanup.
8. Permanent delete and Empty Trash require the exact `DELETE PERMANENTLY` phrase at every layer.
9. A plan is bound to provider, folders, filters, action, and message IDs by a hash; stale/expired/changed plans cannot execute.
10. Each message is re-read and revalidated immediately before mutation; moved or changed messages are skipped.
11. Ambiguous provider outcomes are reported as uncertain, not success, and are not blindly retried.
12. Cancellation is never described as rollback.
13. Gmail's full-mailbox scope is never requested.
14. Credentials never appear in browser responses, logs, errors, fixtures, or commits.
15. Automated tests never contact a real mailbox.

If a change cannot preserve an invariant, explain why in the pull request and expect design discussion before merge.

## Testing

```bash
npm test
npm run test:coverage
npm run bench
```

- Unit tests cover validation, parsers, eligibility, plans, batching, redaction, and provider mapping with mocked `fetch`.
- Integration tests use `SyntheticProvider` and assert mutation counts, pagination, rate-limit behavior, cancellation, partial failure, and stale-plan handling.
- Add regression tests for every bug fix and safety-relevant change.
- Do not weaken or delete a safety test to make a change pass.
- Do not claim live provider behavior was verified without evidence. If you test with a real account, say so and describe the provider/tenant state without including personal data.

See [docs/TESTING.md](docs/TESTING.md) for the test matrix and manual review checklist.

## Adding a provider

1. Add a `ProviderId` entry and capability model in `src/core/capabilities.ts` and `src/shared/types.ts`.
2. Implement `MailProvider` in `src/providers/` with explicit pagination, metadata mapping, mutations, read-only enforcement, and `ProviderError` classification.
3. Add OAuth configuration to `src/providers/manager.ts` and `src/providers/oauth.ts` using authorization code + PKCE and minimum scopes.
4. Reject operations the provider cannot perform safely. Do not emulate permanent deletion with a different destructive operation.
5. Add mocked transport tests, capability tests, and documentation in `docs/PROVIDERS.md`.
6. Add the provider to the UI only after the adapter and tests exist.
7. Update `ROADMAP.md` status honestly; live verification remains unproven until demonstrated.

## Accessibility and UI

- Use semantic HTML and accessible names.
- Preserve keyboard navigation, visible focus, and screen-reader announcements for progress/errors.
- Do not use fabricated account data in the product UI. Demo data belongs only in isolated tests.
- Avoid inline scripts/styles; the CSP intentionally forbids them.
- Keep destructive actions visually and textually distinct, but never rely on color alone.

## Commits and pull requests

- Write focused commits with clear messages.
- Do not commit `dist/`, `coverage/`, `bench/results/`, `.env`, or credentials.
- Describe what changed, why, safety impact, and tests run.
- Link related issues.
- Do not force-push shared branches without maintainer approval.
- Do not publish packages, deploy, or change repository remotes as part of a contribution.

Maintainers may request changes for security, accessibility, licensing, or scope reasons. Final decisions rest with the project maintainers.

## License of contributions

This repository is licensed under the **MIT License** (see [LICENSE](LICENSE)). By submitting a contribution, you agree that it may be distributed under the repository's MIT license.
