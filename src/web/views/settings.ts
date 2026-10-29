import type { ProviderConnectionCheck, ProviderConnectionStatus } from "../../shared/types.js";
import { ApiError, checkProvider, disconnect, startAuth } from "../api.js";
import type { AppContext, View } from "../context.js";
import { alertBox, badge, clear, h } from "../dom.js";
import { formatDate } from "../format.js";

function scopeList(provider: ProviderConnectionStatus): HTMLElement {
  return h("details", {}, [
    h("summary", { text: "Requested OAuth scopes" }),
    h("ul", { class: "small" }, [
      h("li", {}, [
        h("strong", { text: "Read-only: " }),
        h("code", { class: "scope", text: provider.capabilities.auth.readonlyScope }),
      ]),
      h("li", {}, [
        h("strong", { text: "Cleanup: " }),
        h("code", { class: "scope", text: provider.capabilities.auth.cleanupScope }),
      ]),
    ]),
    h("p", {
      class: "hint",
      text: "Read-only authorizes listing and metadata reads. Cleanup adds permission to archive, move, or delete messages, depending on provider support. Only request cleanup access when you intend to execute changes.",
    }),
  ]);
}

function grantedScopesNode(provider: ProviderConnectionStatus): HTMLElement {
  if (provider.grantedScopes.length === 0) {
    return h("span", {
      class: "muted",
      text: "The provider did not report granted scopes for this token.",
    });
  }
  return h(
    "ul",
    { class: "scope-list small" },
    provider.grantedScopes.map((scope) => h("li", {}, [h("code", { class: "scope", text: scope })])),
  );
}

function connectionCheckResult(result: ProviderConnectionCheck): HTMLElement {
  const failed = result.folders.filter((folder) => !folder.accessible);
  return h("div", { class: "stack" }, [
    alertBox(
      result.ok ? "success" : "warning",
      result.ok ? "Read-only connection check passed" : "Connection check found problems",
      [
        h("p", {
          text: result.ok
            ? "All tracked folders were readable. No messages were changed by this check."
            : `${failed.length} folder(s) could not be read. Nothing was changed. Review the details below or reconnect.`,
        }),
      ],
    ),
    h("dl", { class: "kv" }, [
      h("dt", { text: "Account" }),
      h("dd", { text: result.account ?? "Account identity unavailable" }),
      h("dt", { text: "Access" }),
      h("dd", { text: result.mode === "cleanup" ? "Read and cleanup operations" : "Read-only" }),
      h("dt", { text: "Checked" }),
      h("dd", { text: formatDate(result.checkedAt) }),
    ]),
    h("div", { class: "table-wrap" }, [
      h("table", {}, [
        h("caption", { text: "Folder access" }),
        h("thead", {}, [
          h("tr", {}, [
            h("th", { scope: "col", text: "Folder" }),
            h("th", { scope: "col", text: "Result" }),
            h("th", { scope: "col", text: "Provider count" }),
            h("th", { scope: "col", text: "Detail" }),
          ]),
        ]),
        h(
          "tbody",
          {},
          result.folders.map((folder) =>
            h("tr", {}, [
              h("td", { text: folder.displayName }),
              h("td", {}, [
                badge(folder.accessible ? "Readable" : "Failed", folder.accessible ? "pass" : "failed"),
              ]),
              h("td", {
                text:
                  folder.messageCount === null
                    ? "Not reported"
                    : new Intl.NumberFormat().format(folder.messageCount),
              }),
              h("td", { class: "wrap", text: folder.error ?? "—" }),
            ]),
          ),
        ),
      ]),
    ]),
    h(
      "ul",
      { class: "small" },
      result.warnings.map((warning) => h("li", { text: warning })),
    ),
    h("details", {}, [
      h("summary", { text: "Check limitations" }),
      h(
        "ul",
        { class: "small" },
        result.limitations.map((limitation) => h("li", { text: limitation })),
      ),
    ]),
  ]);
}

function connectionCheckPanel(provider: ProviderConnectionStatus): HTMLElement {
  const resultSlot = h("div", { "aria-live": "polite" });
  const button = h("button", {
    class: "btn btn-small",
    type: "button",
    text: "Check read-only connection",
    on: {
      click: () => {
        button.disabled = true;
        button.textContent = "Checking folder access…";
        clear(resultSlot);
        void checkProvider(provider.provider)
          .then((result) => {
            resultSlot.append(connectionCheckResult(result));
          })
          .catch((error: unknown) => {
            clear(resultSlot);
            resultSlot.append(
              alertBox("danger", "Connection check failed", [
                h("p", {
                  text:
                    error instanceof ApiError
                      ? error.message
                      : "The local server could not complete the connection check.",
                }),
              ]),
            );
          })
          .finally(() => {
            button.disabled = false;
            button.textContent = "Check read-only connection";
          });
      },
    },
  });

  return h("div", { class: "stack" }, [
    h("div", { class: "btn-row" }, [button]),
    h("p", {
      class: "hint",
      text: "Reads folder access and basic mailbox metadata only. It never archives, trashes, deletes, or downloads message bodies.",
    }),
    resultSlot,
  ]);
}

function connectControls(
  provider: ProviderConnectionStatus,
  context: AppContext,
  onError: (message: string) => void,
): HTMLElement[] {
  const controls: HTMLElement[] = [];
  const connect = (mode: "readonly" | "cleanup", label: string, primary: boolean) => {
    const button = h("button", {
      class: `btn btn-small${primary ? " btn-primary" : ""}`,
      type: "button",
      text: label,
      on: {
        click: () => {
          button.disabled = true;
          button.textContent = "Opening authorization…";
          void startAuth(provider.provider, mode)
            .then((result) => {
              if (result.authorizeUrl) {
                window.location.assign(result.authorizeUrl);
                return;
              }
              button.textContent = "Continue in your browser…";
              window.setTimeout(() => {
                if (!button.isConnected) return;
                button.disabled = false;
                button.textContent = label;
              }, 15_000);
            })
            .catch((error: unknown) => {
              button.disabled = false;
              button.textContent = label;
              onError(error instanceof ApiError ? error.message : "Could not start authorization.");
            });
        },
      },
    });
    controls.push(button);
  };

  if (provider.connected) {
    controls.push(
      h("button", {
        class: "btn btn-small",
        type: "button",
        text: "Disconnect and clear credentials",
        on: {
          click: (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            void disconnect(provider.provider)
              .then(() => context.refreshStatus())
              .then(() => context.rerender())
              .catch((error: unknown) => {
                button.disabled = false;
                onError(error instanceof ApiError ? error.message : "Could not disconnect.");
              });
          },
        },
      }),
    );
    if (provider.mode === "readonly") {
      connect("cleanup", "Reconnect with cleanup access", false);
    }
    return controls;
  }

  if (!provider.configured) {
    controls.push(
      h("p", {
        class: "small muted",
        text: "OAuth client registration is required before connecting. Copy .env.example to .env and set the provider client ID, then restart the server.",
      }),
    );
    return controls;
  }

  connect("readonly", "Connect read-only", true);
  connect("cleanup", "Connect with cleanup access", false);
  return controls;
}

export const renderSettings: View = (root, context) => {
  const errorSlot = h("div", {});

  const providerCards = context.status.providers.map((provider) => {
    const statusBadge = !provider.configured
      ? badge("Not configured", "planned")
      : provider.connected
        ? badge(
            provider.mode === "cleanup" ? "Cleanup access" : "Read-only",
            provider.mode === "cleanup" ? "warning" : "pass",
          )
        : badge("Ready to connect", "info");
    return h("article", { class: "card", "aria-labelledby": `settings-${provider.provider}` }, [
      h("div", { class: "card-head" }, [
        h("h2", { id: `settings-${provider.provider}`, text: provider.displayName }),
        statusBadge,
      ]),
      provider.connected
        ? h("dl", { class: "kv" }, [
            h("dt", { text: "Account" }),
            h("dd", { text: provider.account ?? "Account identity unavailable" }),
            h("dt", { text: "Access" }),
            h("dd", { text: provider.mode === "cleanup" ? "Read and cleanup operations" : "Read-only" }),
            h("dt", { text: "Connected" }),
            h("dd", { text: formatDate(provider.connectedAt) }),
            h("dt", { text: "Token storage" }),
            h("dd", {
              text: "Encrypted-in-transit OAuth tokens held in local server memory only. Not written to disk or exposed to the browser.",
            }),
            h("dt", { text: "Granted scopes" }),
            h("dd", {}, [grantedScopesNode(provider)]),
          ])
        : h("p", {
            class: "muted",
            text: provider.configured
              ? "No account is connected. Connecting opens the provider's own sign-in page."
              : provider.setupHint,
          }),
      provider.scopeWarning
        ? alertBox("warning", "Reported permissions may be incomplete", [
            h("p", { text: provider.scopeWarning }),
          ])
        : null,
      h(
        "div",
        { class: "provider-actions" },
        connectControls(provider, context, (message) => {
          clear(errorSlot);
          errorSlot.append(alertBox("danger", "Connection action failed", [h("p", { text: message })]));
        }),
      ),
      provider.connected ? connectionCheckPanel(provider) : null,
      scopeList(provider),
    ]);
  });

  root.append(
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("div", { class: "eyebrow", text: "Configuration and privacy" }),
        h("h1", { text: "Settings" }),
        h("p", {
          text: "MailSentry uses official OAuth flows, minimal scopes, and memory-only credential storage. It never asks for an email password.",
        }),
      ]),
    ]),
    errorSlot,
    h("div", { class: "grid two" }, providerCards),
    h("section", { class: "section card", "aria-labelledby": "settings-privacy" }, [
      h("h2", { id: "settings-privacy", text: "Privacy, credentials, and retention" }),
      h("h3", { text: "Credentials" }),
      h("ul", {}, [
        h("li", {
          text: "OAuth access and refresh tokens live only in the MailSentry server process memory for this browser session.",
        }),
        h("li", {
          text: "Tokens are never sent to the browser, written to disk, or logged. Restarting the server or clicking Disconnect clears them.",
        }),
        h("li", {
          text: "Sessions expire after 8 hours of inactivity. MailSentry does not implement its own token encryption; it avoids persistence rather than inventing a scheme.",
        }),
        h("li", {
          text: "Revoke access at Google Account permissions or Microsoft account privacy settings if you want provider-side revocation in addition to local disconnect.",
        }),
      ]),
      h("h3", { text: "Retained data" }),
      h("ul", {}, [
        h("li", {
          text: "The server retains the last 5 diagnostic reports and last 20 cleanup job summaries in memory for this session only. This includes domains, counts, and a bounded sample of candidate subjects/senders for reviewed plans.",
        }),
        h("li", {
          text: "Cleanup plans expire after 20 minutes and are deleted after execution. Full message bodies and attachments are never downloaded.",
        }),
        h("li", {
          text: "Application logs (stderr) contain domains, provider names, and aggregate counts. They do not contain tokens, authorization headers, subjects, or sender addresses.",
        }),
        h("li", {
          text: "There is no database, analytics, telemetry, advertising SDK, or hidden background worker.",
        }),
      ]),
      h("h3", { text: "Network destinations" }),
      h("p", {
        class: "small",
        text: "Nothing is contacted until you run a check, connect an account, or scan/execute a cleanup. MailSentry makes no automatic external requests on page load.",
      }),
      h("div", { class: "table-wrap" }, [
        h("table", {}, [
          h("caption", { text: "All destinations are required for the feature you invoke." }),
          h("thead", {}, [
            h("tr", {}, [
              h("th", { scope: "col", text: "Destination" }),
              h("th", { scope: "col", text: "When" }),
              h("th", { scope: "col", text: "Information sent" }),
            ]),
          ]),
          h("tbody", {}, [
            h("tr", {}, [
              h("td", {}, [h("code", { text: "accounts.google.com" })]),
              h("td", { text: "Gmail connect" }),
              h("td", {
                text: "OAuth authorization request, redirect URI, PKCE challenge, state, requested scope",
              }),
            ]),
            h("tr", {}, [
              h("td", {}, [h("code", { text: "oauth2.googleapis.com" })]),
              h("td", { text: "Gmail connect / refresh" }),
              h("td", { text: "Authorization code or refresh token over TLS; returns access token" }),
            ]),
            h("tr", {}, [
              h("td", {}, [h("code", { text: "gmail.googleapis.com" })]),
              h("td", { text: "Gmail scan / cleanup" }),
              h("td", {
                text: "Bearer token, message IDs, label operations; metadata reads only during scans",
              }),
            ]),
            h("tr", {}, [
              h("td", {}, [h("code", { text: "login.microsoftonline.com" })]),
              h("td", { text: "Microsoft connect / refresh" }),
              h("td", { text: "OAuth authorization code or refresh token, PKCE verifier, requested scope" }),
            ]),
            h("tr", {}, [
              h("td", {}, [h("code", { text: "graph.microsoft.com" })]),
              h("td", { text: "Microsoft scan / cleanup" }),
              h("td", {
                text: "Bearer token, folder/message IDs, selected metadata fields, move/delete operations",
              }),
            ]),
            h("tr", {}, [
              h("td", { text: "System DNS resolver" }),
              h("td", { text: "Email Health" }),
              h("td", { text: "MX and TXT queries for the domain and DKIM selector you enter" }),
            ]),
            h("tr", {}, [
              h("td", {}, [h("code", { text: "retrac.ca" })]),
              h("td", { text: "Only if you click the footer link" }),
              h("td", { text: "Normal web request; no query data from MailSentry" }),
            ]),
          ]),
        ]),
      ]),
      h("p", {
        class: "small muted",
        text: "Local processing reduces data collection but does not eliminate provider API visibility or local-machine risk. Your provider still sees API requests, and anyone with access to this machine or browser session may be able to use the connected account until you disconnect.",
      }),
      h("h3", { text: "Safety limits" }),
      h("ul", {}, [
        h("li", {
          text: "Gmail permanent delete and Empty Trash are disabled because MailSentry refuses to request the full-mailbox scope.",
        }),
        h("li", {
          text: "No operation is triggered by loading a page. Scans are metadata-only; execution requires a reviewed plan and, for permanent deletion, a typed confirmation.",
        }),
        h("li", {
          text: "Provider rate limits, bounded batches, limited concurrency, and cancellation prevent unbounded work.",
        }),
      ]),
    ]),
    h("section", { class: "section card", "aria-labelledby": "settings-about" }, [
      h("h2", { id: "settings-about", text: "About" }),
      h("dl", { class: "kv" }, [
        h("dt", { text: "Version" }),
        h("dd", { text: context.status.version }),
        h("dt", { text: "Server" }),
        h("dd", {}, [h("code", { text: context.status.baseUrl })]),
        h("dt", { text: "License" }),
        h("dd", { text: "MIT License (open source; see LICENSE)" }),
        h("dt", { text: "Source" }),
        h("dd", {}, [
          h("a", {
            href: "https://github.com/retrac-ca/mailsentry",
            rel: "noopener noreferrer",
            target: "_blank",
            text: "github.com/retrac-ca/mailsentry",
          }),
        ]),
      ]),
    ]),
  );
};
