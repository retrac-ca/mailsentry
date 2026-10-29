import { h, badge } from "../dom.js";
import type { AppContext, View } from "../context.js";
import { formatDate, providerName } from "../format.js";

function providerStatus(provider: AppContext["status"]["providers"][number]): HTMLElement {
  if (!provider.configured) {
    return h("div", { class: "provider-card" }, [
      h("h3", {}, [provider.displayName, badge("Not configured", "planned")]),
      h("p", { class: "small muted", text: provider.setupHint }),
      h("a", { class: "btn btn-small", href: "#/settings", text: "Setup details" }),
    ]);
  }
  if (!provider.connected) {
    return h("div", { class: "provider-card" }, [
      h("h3", {}, [provider.displayName, badge("Ready to connect", "info")]),
      h("p", {
        class: "small muted",
        text: "OAuth is configured for this provider. No account is connected yet.",
      }),
      h("a", { class: "btn btn-small", href: "#/settings", text: "Connect" }),
    ]);
  }
  return h("div", { class: "provider-card" }, [
    h("h3", {}, [
      provider.displayName,
      badge(
        provider.mode === "cleanup" ? "Cleanup access" : "Read-only",
        provider.mode === "cleanup" ? "warning" : "pass",
      ),
    ]),
    h("p", { class: "small" }, [
      h("strong", { text: provider.account ?? "Connected account" }),
      h("br"),
      h("span", { class: "muted", text: `Since ${formatDate(provider.connectedAt)}` }),
    ]),
    h("div", { class: "provider-actions" }, [
      h("a", { class: "btn btn-small", href: "#/cleanup", text: "Scan mailbox" }),
      h("a", { class: "btn btn-small btn-ghost", href: "#/settings", text: "Manage" }),
    ]),
  ]);
}

export const renderOverview: View = (root, context) => {
  const { status } = context;
  const lastDiagnostic = status.activity.find((item) => item.kind === "diagnostic");
  const lastCleanup = status.activity.find((item) => item.kind === "cleanup");
  const connected = status.providers.filter((provider) => provider.connected);

  root.append(
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("div", { class: "eyebrow", text: "RETRAC · Local-first" }),
        h("h1", { text: "Know your inbox. Protect your email." }),
        h("p", {
          text: "Check public email configuration and review mailbox cleanup before anything changes. Scanning is read-only, execution is explicit, and credentials stay in local server memory.",
        }),
      ]),
      h("button", {
        class: "btn",
        type: "button",
        text: "Refresh summary",
        on: {
          click: () => {
            void context.refreshStatus().then(() => context.rerender());
          },
        },
      }),
    ]),
    h("div", { class: "grid" }, [
      h("section", { class: "card", "aria-labelledby": "overview-connections" }, [
        h("div", { class: "card-head" }, [
          h("h2", { id: "overview-connections", text: "Mailbox connections" }),
          h("span", { class: "pill", text: `${connected.length} connected` }),
        ]),
        h("div", { class: "provider-grid" }, status.providers.map(providerStatus)),
      ]),
      h("section", { class: "card", "aria-labelledby": "overview-health" }, [
        h("div", { class: "card-head" }, [
          h("h2", { id: "overview-health", text: "Last email health check" }),
          h("a", { class: "btn btn-small", href: "#/health", text: "New check" }),
        ]),
        lastDiagnostic
          ? h("div", { class: "stack" }, [
              h("p", { class: "small muted", text: formatDate(lastDiagnostic.at) }),
              h("p", { text: lastDiagnostic.title }),
              h("p", { class: "small", text: lastDiagnostic.summary }),
              badge(
                lastDiagnostic.status === "success" ? "No critical issues found" : "Review findings",
                lastDiagnostic.status === "failed"
                  ? "failed"
                  : lastDiagnostic.status === "partial"
                    ? "warning"
                    : "pass",
              ),
            ])
          : h("p", {
              class: "muted",
              text: "No diagnostics have run in this session. Email Health only runs when you submit a domain.",
            }),
      ]),
      h("section", { class: "card", "aria-labelledby": "overview-cleanup" }, [
        h("div", { class: "card-head" }, [
          h("h2", { id: "overview-cleanup", text: "Last cleanup activity" }),
          h("a", { class: "btn btn-small", href: "#/cleanup", text: "Open cleanup" }),
        ]),
        lastCleanup
          ? h("div", { class: "stack" }, [
              h("p", { class: "small muted", text: formatDate(lastCleanup.at) }),
              h("p", { text: lastCleanup.title }),
              h("p", { class: "small", text: lastCleanup.summary }),
              badge(lastCleanup.status, lastCleanup.status === "success" ? "pass" : "warning"),
            ])
          : h("p", { class: "muted", text: "No cleanup has been scanned or executed in this session." }),
      ]),
      h("section", { class: "card", "aria-labelledby": "overview-safety" }, [
        h("h2", { id: "overview-safety", text: "How MailSentry stays safe" }),
        h("ol", {}, [
          h("li", {
            text: "Scans fetch message metadata only — never bodies or attachments — and never modify mail.",
          }),
          h("li", {
            text: "Every preview is a fixed, server-held plan. Execution rechecks message state before acting.",
          }),
          h("li", {
            text: "Permanent deletion requires a separate typed confirmation and cannot be undone.",
          }),
          h("li", { text: "Folders are selected independently; nothing is selected by default." }),
        ]),
        h("p", { class: "small muted" }, [
          "Read the ",
          h("a", { href: "#/settings", text: "privacy and network notes" }),
          " before connecting an account.",
        ]),
      ]),
      h("section", { class: "card", "aria-labelledby": "overview-providers" }, [
        h("h2", { id: "overview-providers", text: "Provider coverage" }),
        h("ul", {}, [
          h("li", { text: "Gmail: read-only or cleanup (gmail.modify) OAuth; archive and move-to-trash." }),
          h("li", {
            text: "Microsoft 365 / Outlook: read-only or Mail.ReadWrite; archive, move-to-trash, permanent delete, and empty trash.",
          }),
          h("li", {
            text: "Permanent delete and empty trash are disabled for Gmail because they need the full-mailbox scope.",
          }),
        ]),
        h("p", {
          class: "small muted",
          text: "Provider APIs are implemented against documented endpoints but are not live-verified in this repository without your own OAuth registration.",
        }),
      ]),
    ]),
    h("section", { class: "section" }, [
      h("div", { class: "card flat" }, [
        h("h2", { text: "No background work" }),
        h("p", {
          class: "muted",
          text: "MailSentry does not connect, scan, or delete anything when the page loads. Every operation starts from a button you press, and there is no telemetry or analytics.",
        }),
        h("p", {
          class: "small muted",
          text: `Connected providers: ${connected.map((provider) => providerName(provider.provider)).join(", ") || "none"}.`,
        }),
      ]),
    ]),
  );
};
