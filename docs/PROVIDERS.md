# Provider Setup and Status

MailSentry uses official OAuth authorization-code flows with PKCE and provider REST APIs. No email password is ever requested. No provider SDKs are used.

## Readiness matrix

| Provider                | Adapter code | Mocked tests | Live verification | Notes                                               |
| ----------------------- | ------------ | ------------ | ----------------- | --------------------------------------------------- |
| Gmail                   | Implemented  | Yes          | **No**            | Needs a Google Cloud OAuth client and test account  |
| Microsoft 365 / Outlook | Implemented  | Yes          | **No**            | Needs an Entra ID app registration and test mailbox |

“Implemented” means the adapter is written against documented endpoints, has capability enforcement, and is exercised with mocked HTTP. It does **not** mean a live account was used. Verify with your own account before relying on it for destructive work.

---

## Gmail

### Capabilities

| Operation             | Supported | Semantics / limits                                               |
| --------------------- | --------- | ---------------------------------------------------------------- |
| List Inbox/Spam/Trash | Yes       | Gmail labels `INBOX`, `SPAM`, `TRASH`                            |
| Metadata read         | Yes       | `format=metadata`, selected headers only; no body download       |
| Archive               | Yes       | `messages.modify` removing `INBOX`                               |
| Move to Trash         | Yes       | `messages.trash`                                                 |
| Permanent delete      | **No**    | Requires `https://mail.google.com/`, intentionally not requested |
| Empty Trash           | **No**    | Same scope limitation; use Gmail web UI                          |
| Message size          | Yes       | `sizeEstimate` (approximate)                                     |
| Attachment size       | No        | Not available in metadata listing; filter disabled               |
| Bulk-header detection | Yes       | `List-Unsubscribe`, `List-Id`, `Precedence` metadata headers     |

Scopes:

- Read-only mode: `https://www.googleapis.com/auth/gmail.readonly`
- Cleanup mode: `https://www.googleapis.com/auth/gmail.modify`
- Never requested: `https://mail.google.com/`

### Google Cloud setup

1. Open <https://console.cloud.google.com/> and create or select a project.
2. Enable the **Gmail API** for the project.
3. Configure the **OAuth consent screen**:
   - User type: External is typical for personal testing.
   - Add your Google account as a **test user** while the app is in testing.
   - Add the scopes listed above. Google may require verification before broad external use; local testing with test users avoids that for the MVP.
4. Go to **Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: e.g. `MailSentry local`.
   - Authorized redirect URI: exactly
     `http://127.0.0.1:4310/auth/gmail/callback`
     (replace host/port if `MAILSENTRY_BASE_URL` differs; the scheme, host, port, path, and trailing slash must match).
5. Copy the client ID into `.env`:

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   MAILSENTRY_BASE_URL=http://127.0.0.1:4310
   ```

   The client secret is optional for some installed-app flows but is normally required for a Web application client. It stays on the server and is never sent to the browser.

6. Restart MailSentry, open **Settings**, and choose **Connect read-only** or **Connect with cleanup access**.

### Gmail OAuth details

- Authorization endpoint: `https://accounts.google.com/o/oauth2/v2/auth`
- Token endpoint: `https://oauth2.googleapis.com/token`
- Parameter highlights: `response_type=code`, `access_type=offline`, `prompt=consent`, S256 PKCE, `include_granted_scopes=true`.
- Account identity is read from `GET https://gmail.googleapis.com/gmail/v1/users/me/profile` (email address only).
- Access tokens refresh server-side using the refresh token; refresh tokens are memory-only.
- If consent is revoked or refresh fails, the local connection is removed and MailSentry asks you to reconnect.

### Gmail API calls used

| Purpose  | Request                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List IDs | `GET /gmail/v1/users/me/messages?labelIds=…&maxResults=50&fields=messages/id,nextPageToken`                                                                                                                           |
| Metadata | `GET /gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id&metadataHeaders=Precedence&fields=…` |
| Archive  | `POST /gmail/v1/users/me/messages/{id}/modify` with `removeLabelIds: ["INBOX"]`                                                                                                                                       |
| Trash    | `POST /gmail/v1/users/me/messages/{id}/trash`                                                                                                                                                                         |
| Profile  | `GET /gmail/v1/users/me/profile?fields=emailAddress`                                                                                                                                                                  |

Pagination uses Gmail's opaque `nextPageToken`. Metadata fetches are bounded to 4 concurrent requests per page and paced at 20 requests/second. Gmail quota is charged per method; reduce pacing if your project has lower quotas.

### Gmail caveats

- Gmail applies its own classification to Spam; MailSentry only reads the label.
- Archiving a Spam or Trash message is not offered because removing `INBOX` is meaningless there.
- “Delete forever” in the Gmail UI cannot be reproduced with `gmail.modify`; this is a deliberate safety/scope boundary.
- Gmail's `sizeEstimate` is approximate and includes MIME overhead.
- Gmail does not expose attachment sizes in metadata; MailSentry will not infer them from total size.

---

## Microsoft 365 / Outlook

### Capabilities

| Operation               | Supported | Semantics / limits                                                             |
| ----------------------- | --------- | ------------------------------------------------------------------------------ |
| List Inbox/Junk/Deleted | Yes       | Well-known folders `inbox`, `junkemail`, `deleteditems`                        |
| Metadata read           | Yes       | Selected Graph properties; no body/attachment download                         |
| Archive                 | Yes       | `POST /me/messages/{id}/move` to the `archive` folder; fails clearly if absent |
| Move to Trash           | Yes       | Move to `deleteditems`                                                         |
| Permanent delete        | Yes       | `POST /me/messages/{id}/permanentDelete`, typed confirmation                   |
| Empty Trash             | Yes       | Per-message permanent delete of eligible Trash items                           |
| Message size            | Yes       | Graph `size` property                                                          |
| Attachment size         | No        | Not available in list metadata; filter disabled                                |
| Bulk-header detection   | No        | Not requested; sender heuristic is “possible” and excluded by the bulk filter  |

Scopes (delegated):

- Read-only mode: `Mail.Read`
- Cleanup mode: `Mail.ReadWrite`
- Identity: `openid`, `profile`, `email`, `offline_access`

Application permissions (`Mail.ReadWrite` as an app) are not used. MailSentry is a delegated, user-consented local client.

### Microsoft Entra ID setup

1. Open <https://entra.microsoft.com/> → **App registrations** → **New registration**.
2. Name it, e.g. `MailSentry local`.
3. Supported account types: choose based on the mailboxes you need (commonly **Accounts in any organizational directory and personal Microsoft accounts**).
4. Add a **Redirect URI**:
   - Platform: **Web** (or **Mobile and desktop applications** for a public client).
   - URI: exactly `http://127.0.0.1:4310/auth/microsoft/callback`.
5. **API permissions** → Microsoft Graph → Delegated permissions:
   - `Mail.Read`
   - `Mail.ReadWrite`
   - `openid`, `profile`, `email`, `offline_access` are requested as identity scopes.
   - Grant consent if you are an administrator or use the consent prompt when connecting.
6. **Certificates & secrets**:
   - Preferred for a local client: no secret, PKCE public client.
   - If your tenant requires a confidential client, create a client secret and set `MICROSOFT_CLIENT_SECRET`.
   - For public-client PKCE in some tenant configurations, enable **Allow public client flows**.
7. Copy the Application (client) ID and directory (tenant) ID into `.env`:

   ```dotenv
   MICROSOFT_CLIENT_ID=your-application-client-id
   MICROSOFT_CLIENT_SECRET=          # optional
   MICROSOFT_TENANT_ID=common        # or organizations / consumers / tenant-id
   MAILSENTRY_BASE_URL=http://127.0.0.1:4310
   ```

8. Restart MailSentry and connect from **Settings**.

### Microsoft OAuth details

- Authorize: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
- Token: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
- Parameter highlights: `response_type=code`, `response_mode=query`, S256 PKCE, `prompt=select_account`, exact redirect URI.
- Account identity is decoded from the `id_token` returned directly by the token endpoint (display only).
- Access tokens refresh server-side. Refresh failure removes the local connection.

### Microsoft Graph calls used

| Purpose            | Request                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve folder IDs | `GET /me/mailFolders/{inbox\|junkemail\|deleteditems\|archive}?$select=id,displayName,wellKnownName`                                                              |
| List messages      | `GET /me/mailFolders/{id}/messages?$select=id,subject,from,receivedDateTime,size,hasAttachments,isRead,isDraft,flag,categories,parentFolderId,importance&$top=50` |
| Revalidate         | `GET /me/messages/{id}?$select=…`                                                                                                                                 |
| Archive / Trash    | `POST /me/messages/{id}/move` with `{ destinationId }`                                                                                                            |
| Permanent delete   | `POST /me/messages/{id}/permanentDelete`                                                                                                                          |

Pagination uses `@odata.nextLink`. MailSentry accepts only HTTPS links on `graph.microsoft.com` under `/v1.0/` and rejects anything else. Pacing is 10 requests/second, burst 10. Graph throttling (`429`) is honored with `Retry-After`, bounded.

### Microsoft caveats

- Archive requires an actual Archive folder. If the mailbox lacks one, MailSentry reports an error and does not substitute another folder.
- `permanentDelete` behavior can be restricted by tenant policy.
- Moving to Deleted Items is reversible only according to the mailbox's retention policy; MailSentry makes no recovery promise.
- Empty Trash is performed as individual permanent deletes over the eligible, reviewed IDs. Messages added after the preview are not included.
- Personal Outlook.com and work/school tenants can expose different folder and consent behavior.
- MailSentry does not fetch `internetMessageHeaders`, so newsletters are only heuristically detected as “possible” and are never eligible under the bulk filter.

---

## Token lifecycle, storage, and revocation

| Aspect                   | Behavior                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Storage                  | Server process memory only, keyed by browser session and provider                                   |
| Browser exposure         | Never; tokens are not serialized in API responses or bundles                                        |
| Disk                     | Never written by MailSentry                                                                         |
| Access-token expiry      | Refreshed within 30 seconds of expiry using the refresh token                                       |
| Refresh failure          | Local connection removed; user must reconnect                                                       |
| Disconnect               | Deletes local tokens immediately                                                                    |
| Server restart           | All tokens and connections are lost; reconnect required                                             |
| Session idle expiry      | 8 hours; tokens for that session are discarded                                                      |
| Granted scopes           | Displayed in Settings; a warning appears if reported scopes omit the required read or cleanup scope |
| Provider-side revocation | Must be done at Google/Microsoft; local disconnect cannot revoke the grant                          |

Google revocation: <https://myaccount.google.com/permissions>  
Microsoft: account security / **Privacy** → **Apps and services that can access your data** (wording varies by account type).

MailSentry does not implement its own token encryption. It avoids persistence instead of inventing a scheme. Do not add plaintext token files; OS keyring integration is future work.

---

## Testing without credentials

You can validate most behavior without registering anything:

```bash
npm test
```

Relevant suites:

- `tests/unit/providers.test.ts` — mocked Gmail/Graph transport, field mapping, pagination host validation, folder probes, read-only refusal, HTTP retry/error policy.
- `tests/unit/connection-check.test.ts` — read-only folder/metadata connection check and per-folder failures.
- `tests/integration/cleanup.test.ts` — complete cleanup lifecycle using `SyntheticProvider`, including mutation-count assertions.
- `tests/unit/plan.test.ts` — plan hash/token/confirmation gates.
- `tests/integration/server.test.ts` — session, CSRF, Origin/Host checks, unconfigured OAuth behavior.

The synthetic provider is never registered in the running application, so the UI cannot show fabricated mailbox data.

## Manual live-verification checklist

Use a dedicated test mailbox and non-sensitive data. Follow the detailed, evidence-based checklist in [LIVE-VERIFICATION.md](LIVE-VERIFICATION.md).

At minimum:

1. Configure OAuth and connect in **read-only** mode.
2. Confirm the account address and granted scopes in Settings.
3. Run **Check read-only connection**; confirm all tracked folders are readable.
4. Scan each folder separately and confirm counts match the provider UI.
5. Confirm no mutation occurs (provider audit/log or mailbox state).
6. Run a dry run and confirm no mutation.
7. Reconnect with cleanup access.
8. Create a few test messages; archive one batch and verify folder location.
9. Move one batch to Trash and verify.
10. For Microsoft only, test permanent delete and Empty Trash with disposable messages and the typed phrase.
11. Disconnect and confirm the API reports no connection; restart and confirm reconnection is required.
12. Revoke the grant at the provider and confirm a stale session cannot operate.

Record what was verified in the pull request or release notes. Do not claim live verification for a provider you have not tested; sanitize all evidence.

## Troubleshooting

| Symptom                                    | Likely cause / fix                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch` (Google)           | Redirect URI must exactly match `${MAILSENTRY_BASE_URL}/auth/gmail/callback`                                           |
| OAuth returns 400 / session missing        | Use the **same hostname** in the browser and `MAILSENTRY_BASE_URL` (`localhost` and `127.0.0.1` have separate cookies) |
| Microsoft `AADSTS50011`                    | Redirect URI mismatch in the app registration                                                                          |
| Microsoft `AADSTS65001` / consent required | Admin consent or interactive consent for delegated scopes                                                              |
| Microsoft public-client error              | Enable public client flows or configure a client secret                                                                |
| Google “Access blocked”                    | App in testing: add your account as a test user, or complete verification                                              |
| 401 after some time                        | Token expired and refresh failed; reconnect                                                                            |
| 403 on operations                          | Scope too narrow (read-only) or tenant/mailbox restriction; reconnect with cleanup access                              |
| Gmail permanent delete unavailable         | Expected: full-mailbox scope is intentionally not requested                                                            |
| Archive fails on Microsoft                 | No Archive folder in the mailbox                                                                                       |
| No attachment filter                       | Provider list APIs do not expose reliable attachment sizes                                                             |
| Bulk filter finds nothing on Microsoft     | Header inspection is not implemented; uncertain classifications are excluded                                           |
