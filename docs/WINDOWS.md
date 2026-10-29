# Windows Desktop

MailSentry is packaged as an Electron desktop application for 64-bit Windows. The desktop shell starts the existing Node.js HTTP server in-process on `127.0.0.1:4310`, waits for it to bind, and loads the existing browser UI in a hardened Chromium window. No separate terminal, development server, or system-wide Node installation is needed by end users.

## Verified status

| Item                             | Result                                             |
| -------------------------------- | -------------------------------------------------- |
| App version                      | `0.1.0`                                            |
| Electron                         | `45.1.0`                                           |
| Packaged runtime                 | Node `24.22.1` inside Electron                     |
| Build host                       | Windows 11 Home, AMD64                             |
| Native smoke test                | Passed on Windows                                  |
| Normal launch / close / relaunch | Passed on Windows                                  |
| Port-conflict failure handling   | Passed on Windows                                  |
| Installer                        | Built locally; **not installed or upgrade-tested** |
| Portable executable              | Built and smoke-tested on Windows                  |
| Code signing                     | Not configured; artifacts are unsigned             |
| Live Gmail/Microsoft OAuth       | Still not live-verified                            |

The application is ready for Windows testing. It is not a signed public release.

## End-user installation

Two local artifacts are produced by the build:

- `release/MailSentry-Setup-0.1.0-x64.exe` — per-user NSIS installer
- `release/MailSentry-Portable-0.1.0-x64.exe` — portable executable
- `release/win-unpacked/` — unpacked application (development/testing)

The installer is configured for a per-user installation, no elevation, optional install directory, Start Menu shortcut, and desktop shortcut. Uninstall keeps application data by design.

**These files are unsigned.** Windows SmartScreen may warn. Do not claim they are signed unless a certificate is configured and verified.

The generated `release/` directory is ignored by Git. Do not upload these artifacts as part of this task.

## Architecture

```text
MailSentry.exe (Electron main process)
  ├─ loads %APPDATA%\MailSentry\.env (packaged) or repo .env (development)
  ├─ starts the existing MailSentry HTTP server on 127.0.0.1:4310
  ├─ creates a BrowserWindow with:
  │    contextIsolation: true
  │    nodeIntegration: false
  │    sandbox: true
  │    webSecurity: true
  │    in-memory session partition ("mailsentry")
  ├─ restricts navigation to the local origin only
  ├─ denies renderer permissions and webviews
  ├─ opens provider authorization in the system default browser
  ├─ receives the loopback callback using server-side state + PKCE
  └─ stops the HTTP server and closes sockets on quit
```

There is no preload script, no Electron IPC surface, and no Node.js access in the renderer. OAuth authorization pages are **not loaded in the Electron window**: the main process opens them with `shell.openExternal`, and the loopback server receives the callback. State and PKCE verifier are stored server-side; the callback does not depend on sharing the app window's session cookie. External links open in the system browser.

The local server remains the same loopback-only security boundary: CSRF tokens, Origin checks, Host validation, loopback binding, metadata-only scans, plan revalidation, and typed destructive confirmations are unchanged.

### OAuth flow

1. The renderer asks the local server to start authorization.
2. The server creates a random 192-bit `state` value and an S256 PKCE verifier/challenge, stores them in memory with the initiating app session, provider, and mode, and returns no authorization URL to the renderer in desktop mode.
3. The Electron main process opens the provider authorization URL in the system default browser with `shell.openExternal`.
4. The provider redirects to the existing `http://127.0.0.1:4310/auth/.../callback` route. The callback is validated from the server-side state alone; it does not require the Electron session cookie.
5. State is single-use, expires after 10 minutes, and is consumed before any token exchange. Missing, unknown, reused, expired, or provider-mismatched state is rejected.
6. On success the system browser shows “You can return to MailSentry.”, the Electron window reloads, and the window is brought to the front. Tokens remain in server memory only.
7. On denial or failure, the state is consumed (when known), the browser shows a short failure page, and the app window is not treated as connected.

Provider pages are provider-controlled and open in the user's normal browser. OAuth client secrets and provider login cookies are not handled by the Electron renderer.

## Requirements

### End users

- 64-bit Windows 10 or Windows 11. Verified on Windows 11 (build `10.0.26200`).
- No Node.js, npm, WSL, or developer tools.
- Internet access for DNS checks and provider APIs.

### Building

- Windows 10/11 x64 with Node.js **22.x** (CI uses 22.23.2) and npm 10+.
- For Linux/WSL: Node.js **22.x** (CI uses 22.23.2) and npm 10+. Windows `win-unpacked` and ZIP artifacts can be produced, but the NSIS installer needs Wine or a native Windows build host. This repository was validated with a native Windows build.

## Development

On Windows PowerShell from the repository:

```powershell
npm ci
npm run build
npm run desktop
```

`npm run desktop` builds the server and browser assets, then launches Electron. The window loads the local app. Closing it stops the in-process server.

On WSL/Linux (source checks only):

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Electron itself may not launch in WSL without a working Linux display/library set. Use Windows for desktop runtime testing.

## Packaging for Windows

### Native Windows build (recommended)

```powershell
npm ci
npm run dist:win
```

This runs the type checks/build and produces:

```text
release\MailSentry-Setup-0.1.0-x64.exe
release\MailSentry-Portable-0.1.0-x64.exe
release\MailSentry-Setup-0.1.0-x64.exe.blockmap
release\win-unpacked\
```

For a quick unpacked-only build:

```powershell
npm run dist:win:dir
```

### WSL/Linux

```bash
npm ci
npm run dist:win:dir
npx electron-builder --win zip --x64 --prepackaged release/win-unpacked
```

The NSIS installer target fails on a plain WSL host with `wine process failed ENOENT` unless Wine is installed. Use a Windows build host for the installer. The portable ZIP/`win-unpacked` directory is still useful for testing.

### Artifact metadata

- Product name: MailSentry
- Company: RETRAC
- Version: `0.1.0`
- Installer/portable format: x64 PE executables
- Installer type: NSIS per-user, non-one-click
- Signing: none

## Configuration

### Location

Packaged app data lives under Electron's Windows user-data directory:

```text
%APPDATA%\MailSentry\
  .env                 # optional OAuth configuration; not created automatically
  .env.example         # template written on first launch
  logs\
    mailsentry.log      # rotated at 5 MB to mailsentry.log.1
  window-state.json     # last window size / maximized state
  ...                   # Chromium cache/storage files
```

The first launch copies `.env.example` from the packaged app into this folder. To configure providers, copy `.env.example` to `.env`, fill in the OAuth client values, and restart MailSentry.

For isolated tests only, `MAILSENTRY_USER_DATA_DIR` can override the user-data directory.

### Required desktop settings

The desktop shell supports only a plain loopback origin:

```dotenv
MAILSENTRY_HOST=127.0.0.1
PORT=4310
MAILSENTRY_BASE_URL=http://127.0.0.1:4310
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=            # Google Desktop app clients receive a secret
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=         # leave blank for a public client
MICROSOFT_TENANT_ID=common
```

`MAILSENTRY_BASE_URL` must be exactly `http://127.0.0.1:<PORT>`. Do not use `localhost`, HTTPS, a reverse proxy, or a path. Use the same host/port in the OAuth app registrations:

```text
http://127.0.0.1:4310/auth/gmail/callback
http://127.0.0.1:4310/auth/microsoft/callback
```

OAuth client IDs and client secrets are not embedded in the application. Users or deployers must register their own provider applications and configure them in `.env`. Google Desktop app clients receive a client secret; set `GOOGLE_CLIENT_SECRET`. Microsoft public clients (`Mobile and desktop applications`) need no secret. Provider setup is in [PROVIDERS.md](PROVIDERS.md). Client secrets in `.env` are plaintext within the Windows user profile; protect that file and do not include it in backups/support bundles.

### Data not persisted

- OAuth access/refresh tokens: server process memory only.
- OAuth state and PKCE verifiers: server process memory only, 10-minute TTL.
- Session IDs/CSRF tokens: memory + in-memory browser session.
- Cleanup plans, jobs, diagnostics: memory only.
- Provider login cookies: handled by the user's system browser, not by the Electron renderer.
- Full message bodies/attachments: never downloaded.

Chromium may write standard cache/state files under the user-data directory, but no provider authorization pages are rendered there and the app's session partition is cleared at startup.

## Startup, shutdown, and errors

- **Single instance:** launching a second copy focuses the existing window.
- **Readiness:** the window is created only after the HTTP server has bound successfully.
- **Port conflict:** startup fails with a clear error; the app does not silently switch ports because OAuth redirects are registered for a specific port.
- **Shutdown:** closing the window stops the server and closes open sockets; no orphaned `MailSentry.exe` process was observed in validation.
- **Active cleanup:** closing the window while a cleanup job is running shows a warning; quitting interrupts the job without rollback and can leave in-flight operations uncertain.
- **Logs:** JSON lines are written to `%APPDATA%\MailSentry\logs\mailsentry.log` (rotated at 5 MB) with the existing credential redaction rules.
- **Missing configuration:** the app still launches; Email Health works and provider setup guidance is shown in Settings.
- **Startup/config errors:** a Windows dialog points to the log and config folder.

## Smoke testing

For a development smoke test:

```powershell
npm run desktop:smoke
Get-Content .\desktop-smoke.json
```

The packaged app supports the same read-only smoke mode. It starts the real server, loads the real renderer, checks the rendered heading and `/api/status`, writes a JSON result, and exits.

```powershell
$env:MAILSENTRY_USER_DATA_DIR = "$env:TEMP\mailsentry-smoke-data"
$env:MAILSENTRY_SMOKE_FILE = "$env:TEMP\mailsentry-smoke.json"
& "C:\path\to\MailSentry.exe" "--smoke-test=$env:MAILSENTRY_SMOKE_FILE"
Get-Content $env:MAILSENTRY_SMOKE_FILE
```

Expected successful result includes `"ok": true`, the window title, main heading, six navigation items, app name/version, and provider configuration flags. The smoke test performs no DNS queries, OAuth, scans, or mailbox mutations.

## Manual Windows validation checklist

Run on a test Windows machine/VM, never against a primary mailbox:

- [ ] Fresh launch with no `%APPDATA%\MailSentry\.env`.
- [ ] Overview, Email Health, Mailbox Cleanup, Activity, Settings, Roadmap navigation.
- [ ] Email Health for a public domain.
- [ ] Add OAuth values to `%APPDATA%\MailSentry\.env`; restart.
- [ ] Connect Gmail/Microsoft read-only; confirm the system browser opens, the callback page appears, and the app window comes to the front.
- [ ] **Check read-only connection**.
- [ ] Scan and dry-run only test messages; verify no mailbox changes.
- [ ] Close the window; confirm no `MailSentry.exe` remains in Task Manager.
- [ ] Relaunch; confirm window size and logs are retained.
- [ ] Occupy port 4310 with another program; confirm an actionable startup error.
- [ ] Install the NSIS package on a disposable Windows profile; launch, upgrade, and uninstall.
- [ ] Confirm uninstall does not unexpectedly delete `%APPDATA%\MailSentry` (data retention is intentional).
- [ ] Revoke provider grants after testing.

Installer execution/upgrade/uninstall is **not** verified in this repository. Treat it as a manual release gate.

## Troubleshooting

| Symptom                                   | Resolution                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| App does not start; port error            | Close the process using port 4310, or change `PORT` and update both OAuth redirect URIs.            |
| Desktop rejects the config                | Use `MAILSENTRY_HOST=127.0.0.1` and `MAILSENTRY_BASE_URL=http://127.0.0.1:4310` exactly.            |
| OAuth redirect mismatch                   | Register the exact callback URI shown above; do not use `localhost` when the app uses `127.0.0.1`.  |
| `wine process failed ENOENT`              | NSIS is being built on Linux/WSL without Wine; build on Windows or produce only `win-unpacked`/ZIP. |
| SmartScreen warning                       | Expected for unsigned artifacts. Sign with a trusted certificate before public distribution.        |
| Window is blank                           | Check `%APPDATA%\MailSentry\logs\mailsentry.log`; rebuild to ensure `dist/public` is present.       |
| Provider actions fail                     | Check granted scopes in Settings, reconnect with cleanup access, and verify provider permissions.   |
| Port conflict error mentions `EADDRINUSE` | Another instance/program owns 4310; only one MailSentry instance is allowed.                        |
| System browser does not open              | Check the Windows default-browser configuration; start the connection again.                        |
| Callback page says unknown/expired state  | Authorization took over 10 minutes, was reused, or the app restarted. Close it and connect again.   |

## Known limitations

- OAuth provider pages open in the system default browser; if no browser opens, check the Windows default-browser configuration.
- Live Gmail/Microsoft OAuth has not been verified against real accounts.
- Installer installation, upgrade, uninstall, and code signing are not verified.
- No auto-update mechanism.
- Electron adds a large runtime and memory footprint compared with the headless server.
- The desktop shell intentionally supports only `http://127.0.0.1` with a fixed port, not custom HTTPS/reverse-proxy deployments.
- Provider login cookies live in the system browser; MailSentry does not clear or manage them.
- No independent security audit.
