# Live Provider Verification

This checklist is the evidence record for turning “implemented and mocked-tested” into “live-verified.” Do not mark a provider verified until every required item in its run sheet has actually been performed.

**Never use a primary mailbox. Never include tokens, client secrets, personal email addresses, message contents, or message IDs in this file, an issue, or a screenshot.**

## Status snapshot

| Provider                | Adapter | Mocked tests | Read-only live check | Cleanup live check | Permanent delete live check | Live-verified |
| ----------------------- | ------- | ------------ | -------------------- | ------------------ | --------------------------- | ------------- |
| Gmail                   | Yes     | Yes          | No                   | No                 | Not applicable (disabled)   | **No**        |
| Microsoft 365 / Outlook | Yes     | Yes          | No                   | No                 | No                          | **No**        |

Last updated: 2026-10-29.

## Safety rules

1. Use dedicated test mailboxes and disposable messages.
2. Connect in **read-only** mode first.
3. Confirm scanning and dry runs change nothing in the provider UI.
4. Execute one small batch before any larger test.
5. Never use Gmail permanent delete or Empty Trash — the required scope is intentionally not requested.
6. For Microsoft permanent delete/Empty Trash, use only disposable messages and type the confirmation phrase deliberately.
7. Disconnect and revoke access when finished.
8. Sanitize all evidence before sharing.

## Prerequisites

- Node.js 22.x (CI uses 22.23.2) and the repository checked out.
- `.env` with the correct `MAILSENTRY_BASE_URL` and matching `PORT`.
- Google OAuth client and/or Microsoft Entra app registered exactly as described in [PROVIDERS.md](PROVIDERS.md).
- A test mailbox with a few read, unstarred, non-important messages from a unique test sender.
- An incognito browser profile is recommended to avoid mixing sessions.

## Recording results

Copy this template into the pull request, release note, or a private verification record. Remove all personal data.

```text
Provider:
Account type (personal/org):
Commit:
Date:
Mode tested (readonly/cleanup):
Browser/OS:

Connection check:
  Passed? yes/no
  Folders readable:
  Counts reported:
  Scope warning shown? yes/no

Scan:
  Folders selected:
  Filters:
  Eligible count:
  Count matched provider UI? yes/no
  Mutations observed? none/other

Dry run:
  Processed:
  Failed:
  Uncertain:
  Mailbox unchanged in provider UI? yes/no

Cleanup (small batch):
  Action:
  Messages:
  Succeeded/failed/skipped/uncertain:
  Verified in provider UI? yes/no

Permanent delete (Microsoft only, disposable messages):
  Result:
  Verified? yes/no

Disconnect/restart:
  Connection cleared? yes/no
  Reconnect required? yes/no

Sanitized errors/notes:
```

## Gmail run sheet

### Read-only verification

- [ ] Google Cloud project created; Gmail API enabled.
- [ ] OAuth consent screen configured; test account added.
- [ ] Web OAuth client redirect URI exactly `http://127.0.0.1:4310/auth/gmail/callback` (or the configured origin).
- [ ] `GOOGLE_CLIENT_ID` and optional `GOOGLE_CLIENT_SECRET` set in `.env`; server restarted.
- [ ] Connected Gmail with **read-only** access.
- [ ] Authorization opened in the system default browser, not inside the Electron window.
- [ ] The loopback callback page said “You can return to MailSentry,” and the app window came to the front.
- [ ] Settings shows the account, mode, and granted scopes.
- [ ] **Check read-only connection** passes for Inbox, Spam, and Trash.
- [ ] A scan selects only test messages by sender; counts look plausible.
- [ ] A dry run completes; Gmail shows no changes.
- [ ] No Gmail permanent delete or Empty Trash option is available.

### Cleanup verification

- [ ] Reconnected with cleanup access.
- [ ] Grant includes `gmail.modify` (shown in Settings, or no scope warning).
- [ ] Scanned only the test messages again.
- [ ] Executed **Move to Trash** on one small batch.
- [ ] Gmail UI confirms only those messages moved.
- [ ] Disconnect clears the connection.
- [ ] Restarting MailSentry requires reconnection.
- [ ] Provider grant revoked at <https://myaccount.google.com/permissions> after testing.

## Microsoft 365 / Outlook run sheet

### Read-only verification

- [ ] Entra app registered with the exact redirect URI `http://127.0.0.1:4310/auth/microsoft/callback` (or the configured origin).
- [ ] Delegated permissions `Mail.Read`, `Mail.ReadWrite`, `openid`, `profile`, `email`, `offline_access` added; consent granted if required.
- [ ] `MICROSOFT_CLIENT_ID`, optional secret, and tenant ID set; server restarted.
- [ ] Connected with **read-only** access.
- [ ] Authorization opened in the system default browser, not inside the Electron window.
- [ ] The loopback callback page appeared and the app window came to the front.
- [ ] Settings shows account, mode, granted scopes, and no unexpected scope warning.
- [ ] **Check read-only connection** passes for Inbox, Junk Email, and Deleted Items.
- [ ] A scan selects only test messages; counts look plausible.
- [ ] A dry run completes; Outlook shows no changes.

### Cleanup and destructive verification

- [ ] Reconnected with cleanup access; `Mail.ReadWrite` reported.
- [ ] Executed **Move to Trash** on one small batch; verified in Outlook.
- [ ] Optional: archived one disposable batch; verified in the Archive folder.
- [ ] Optional: permanently deleted one disposable batch with typed confirmation; verified in Outlook.
- [ ] Optional: tested Empty Trash with disposable messages and typed confirmation.
- [ ] No operation reported success without provider confirmation.
- [ ] Disconnect clears the connection; restart requires reconnection.
- [ ] Provider grant revoked in Microsoft account settings after testing.

## Acceptance criteria for “live-verified”

A provider may be marked live-verified only when:

- [ ] The read-only run sheet is complete and passed.
- [ ] One small reversible cleanup batch was executed and verified in the provider UI.
- [ ] Results matched the preview counts and actions.
- [ ] No credential or personal data appears in recorded evidence.
- [ ] Any defects found were fixed and the run was repeated successfully.
- [ ] The status is updated in `README.md`, `ROADMAP.md`, and this file in the same change.

Permanent-delete live verification is required only for Microsoft, where the feature is supported. Gmail permanent delete remains disabled by design.

## Updating status after verification

When a provider passes:

1. Change its Phase 1 roadmap item from `[~]` to `[x]`.
2. Remove or narrow the “live verification blocked” roadmap item if both providers are verified.
3. Update the README provider table and status paragraph.
4. Record the sanitized evidence summary in the verification record.
5. Keep the app’s “not independently audited” statement unchanged.

## Known expected limitations during verification

- Gmail permanent delete and Empty Trash are disabled (`https://mail.google.com/` is not requested).
- Attachment-size filtering is unavailable because list APIs do not expose reliable attachment sizes.
- Gmail message counts may display “Not reported” in the connection check.
- Microsoft Archive requires an Archive folder; a missing folder is reported as an error.
- OAuth must use the same hostname as `MAILSENTRY_BASE_URL`; switching between `localhost` and `127.0.0.1` loses the session cookie.
- DNS or provider outages can produce inconclusive results; retry before changing configuration.
