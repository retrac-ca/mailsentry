# Privacy and Network Transparency

MailSentry is designed to minimize data collection. It has no accounts, telemetry, analytics, advertising SDKs, crash reporting, remote configuration, or hidden background jobs.

Local-first does not mean risk-free: provider APIs still see requests, OAuth identity providers see consent events, DNS resolvers see queried names, and the local machine/browser session must be trusted.

## Data MailSentry processes

| Data                                                          | Where it lives                           | Purpose                                    | Retention                                           |
| ------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Domain and optional DKIM selector                             | Server memory + stderr log (domain only) | DNS diagnostics                            | Last 5 reports per session; session ≤8 h idle       |
| DNS findings/observations                                     | Server memory                            | Display results                            | Same as above                                       |
| Provider OAuth access/refresh tokens                          | Server process memory                    | API calls and refresh                      | Until disconnect, server restart, or session expiry |
| OAuth state and PKCE verifier                                 | Server process memory                    | Desktop/system-browser callback validation | 10-minute TTL / consumed before exchange            |
| Account email address                                         | Server memory                            | Display connection identity                | Until disconnect/restart                            |
| Granted OAuth scope names                                     | Server memory + status API               | Permission diagnostics in Settings         | Until disconnect/restart                            |
| Message IDs, folder, size, dates, subject/from snippet sample | Server memory                            | Preview, revalidation, execution, results  | Plan ≤20 min; job summaries up to 20 per session    |
| Cleanup job results                                           | Server memory                            | Progress/results/Activity                  | Up to 20 jobs per session                           |
| Session ID + CSRF token                                       | Memory + HttpOnly cookie                 | Authenticate local session / prevent CSRF  | Cookie is session-scoped; server TTL 8 h            |

**Never downloaded or stored:** message bodies, full attachments, attachment contents, full mailbox listings, contacts, calendar data, passwords.

**Never persisted to disk by MailSentry:** tokens, mailbox metadata, diagnostics, plans, jobs. Restarting the server clears everything.

**Logs:** JSON lines to stderr at `info` by default. They include timestamp, scope, event, provider, action, domain for diagnostics, and aggregate counts. They deliberately omit tokens, authorization headers, subjects, sender addresses, message IDs, and request bodies. The operator's terminal or process supervisor controls log retention. Set `MAILSENTRY_LOG_LEVEL=warn` or `error` to reduce output.

## Windows desktop data

The packaged Electron app stores its desktop-specific data under:

```text
%APPDATA%\MailSentry\
  .env                 # optional OAuth client configuration
  .env.example         # template copied on first launch
  logs\mailsentry.log  # redacted JSON logs, rotated at 5 MB
  window-state.json    # window size/maximized state
  ...                  # Chromium cache/state files
```

OAuth tokens, session IDs, cleanup plans/jobs, and diagnostics remain memory-only. The Desktop uses a non-persistent Chromium partition for the app UI and clears its storage at startup. Provider login cookies and authorization pages belong to the user's system browser in desktop mode. The local HTTP server still contacts providers and DNS only when the corresponding feature is invoked. See [WINDOWS.md](WINDOWS.md).

## Cookies and browser storage

- One cookie: `ms_sid`, a random session identifier.
- Flags: `HttpOnly` (not readable by JavaScript), `SameSite=Lax` (blocks cross-site POSTs while allowing top-level navigation), `Path=/`, and `Secure` when the base URL is HTTPS.
- No persistent `Max-Age` is set; the browser may keep it for the tab session, while the server expires idle sessions after 8 hours.
- No `localStorage`, `sessionStorage`, IndexedDB, or service worker is used for credentials or mailbox data. The UI keeps only in-memory view state.
- CSRF token is provided in the `/api/status` response and kept in a JavaScript variable, not a cookie or persistent storage.

## Network destinations

Nothing external is contacted on page load. Requests occur only when you invoke a feature.

| Destination                                                  | Trigger                              | Information sent                                                                                       | Response used                             |
| ------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| System DNS resolver (from `/etc/resolv.conf` or OS settings) | Email Health                         | MX/TXT query names for the domain and DKIM selector you enter                                          | MX targets/priorities, TXT records        |
| `accounts.google.com`                                        | Click **Connect** for Gmail          | OAuth client ID, redirect URI, requested scope, state, PKCE challenge                                  | Authorization code (via browser redirect) |
| `oauth2.googleapis.com`                                      | Gmail connect or token refresh       | Authorization code + PKCE verifier or refresh token, client ID, optional client secret                 | Access/refresh tokens, scope, expiry      |
| `gmail.googleapis.com`                                       | Gmail scan/preview/execute/check     | Bearer access token, message IDs, label filters, requested metadata fields, archive/trash operations   | Message metadata and operation results    |
| `login.microsoftonline.com`                                  | Microsoft connect or refresh         | Client ID, redirect URI, scope, state, PKCE challenge, code/verifier or refresh token, optional secret | Tokens and identity claims                |
| `graph.microsoft.com`                                        | Microsoft scan/preview/execute/check | Bearer token, folder/message IDs, selected metadata fields, move/permanent-delete operations           | Message metadata and operation results    |
| `retrac.ca`                                                  | Only if you click the footer link    | Standard browser request; no MailSentry data appended                                                  | Public web page                           |

Provider requests are HTTPS. Redirects are disabled for provider API/token calls. Graph pagination is restricted to `graph.microsoft.com`; Gmail pagination tokens are opaque.

There are **no** calls to analytics, CDNs, font services, error trackers, package registries, or AI services. The browser loads only same-origin `/app.js`, `/styles.css`, and `/favicon.svg`, consistent with the Content Security Policy. In the Windows desktop app, provider authorization opens in the user's system default browser, not in the Electron renderer. The local loopback callback receives only the provider's authorization response; the app window's cookies are not shared with that browser. Provider login cookies remain the browser's responsibility.

## Information visible to third parties

- **Google/Microsoft** see the API calls and the account they are authorized for, including message IDs and operations requested. Their privacy terms and logging apply. In desktop mode their authorization/consent pages are opened in the system browser, so the provider sees the normal browser session and cookies.
- **The DNS resolver** sees the domain and selector being checked. Use a resolver you trust, or run MailSentry with a resolver you control.
- **Your network operator** may observe DNS queries and TLS metadata.
- **The local machine** can observe process memory if compromised; tokens are not encrypted in memory.

## What MailSentry does not do

- No ad or analytics IDs.
- No fingerprinting, device identifiers, or “anonymous” telemetry.
- No remote feature flags or remote code.
- No email content analysis.
- No automatic unsubscription, spam reporting, forwarding, or sending.
- No DNS modification.
- No cloud sync or multi-device account.
- No sale or sharing of data (there is no data collection to sell).
- No hidden background network calls or scheduled jobs.

## Provider permissions

| Mode      | Gmail            | Microsoft                          |
| --------- | ---------------- | ---------------------------------- |
| Read-only | `gmail.readonly` | `Mail.Read` + identity scopes      |
| Cleanup   | `gmail.modify`   | `Mail.ReadWrite` + identity scopes |

MailSentry never requests Gmail's `https://mail.google.com/` full scope, so it cannot permanently delete Gmail messages. Cleanup access is requested only when you choose it; read-only is sufficient for diagnostics, scans, previews, and dry runs.

You can revoke grants at:

- Google: <https://myaccount.google.com/permissions>
- Microsoft: account **Privacy** / **Apps and services** (wording varies)

Disconnecting in MailSentry deletes local tokens immediately but does not revoke the provider grant.

## Retention and deletion

- **Disconnect** removes local tokens for that provider.
- **Restart** clears all tokens, sessions, plans, jobs, and diagnostics.
- **Session idle expiry** (8 hours) clears that session's data and tokens.
- Plans expire after 20 minutes and are consumed by real execution.
- Finished jobs are capped at 20 per session; diagnostics at 5.
- No user-facing data export or “delete history” exists beyond restart/disconnect because nothing is persisted.

Browser caches may retain static JS/CSS; these contain no user data. Provider APIs and DNS resolvers retain their own logs under their policies.

## Privacy limitations

- MailSentry cannot control provider-side retention, government access, or resolver logging.
- A compromised browser extension, local malware, or shared unlocked device can act within the authorized session.
- Metadata can still be sensitive: subjects, senders, dates, and message counts may reveal relationships or behavior. The preview sample is bounded but visible on screen and held in server memory during the session.
- Aggregate counts and domains may appear in stderr logs.
- The benchmark uses synthetic data only; it performs no network calls.
- Running with a non-loopback bind is unsupported and increases exposure. Plain HTTP to a non-loopback host is rejected by configuration.

## Verification

To inspect network behavior yourself:

1. Use browser developer tools → Network; you should see only same-origin assets and API calls.
2. Use `strace -f -e trace=network -p <pid>` or an OS firewall to observe outbound connections.
3. Inspect `src/providers/*` for the complete list of provider endpoints.
4. Search the repository for telemetry/analytics libraries; there are none, and runtime dependencies are empty.

Report privacy concerns through the security reporting process in [SECURITY.md](../SECURITY.md) if they involve vulnerability or data exposure.
