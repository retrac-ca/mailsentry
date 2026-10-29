import type { DiagnosticCheck, DiagnosticReport } from "../../shared/types.js";
import { ApiError, runDiagnostics } from "../api.js";
import type { View } from "../context.js";
import { alertBox, badge, clear, h } from "../dom.js";
import { formatDate, severityLabel } from "../format.js";

let remembered: { domain: string; selector: string; report: DiagnosticReport } | null = null;

const CHECKS: Array<{ id: DiagnosticCheck; label: string; description: string }> = [
  { id: "mx", label: "MX", description: "Where inbound mail is delivered" },
  { id: "spf", label: "SPF", description: "Which hosts may send mail" },
  { id: "dkim", label: "DKIM", description: "Published signing keys for a selector" },
  { id: "dmarc", label: "DMARC", description: "Policy and reporting for authentication failures" },
];

function findingNode(finding: DiagnosticReport["findings"][number]): HTMLElement {
  return h("article", { class: `finding ${finding.severity}` }, [
    h("div", { class: "finding-head" }, [
      h("h3", { text: finding.title }),
      h("div", { class: "btn-row" }, [
        badge(severityLabel(finding.severity), finding.severity),
        badge(
          finding.confidence === "confirmed" ? "Confirmed" : "Inconclusive",
          finding.confidence === "confirmed" ? "info" : "uncertain",
        ),
      ]),
    ]),
    h("dl", {}, [
      h("dt", { text: "Observed" }),
      h("dd", { text: finding.observed }),
      h("dt", { text: "Why it matters" }),
      h("dd", { text: finding.whyItMatters }),
      h("dt", { text: "Next step" }),
      h("dd", { text: finding.recommendation }),
    ]),
  ]);
}

function reportNode(report: DiagnosticReport): HTMLElement {
  const counts = { critical: 0, warning: 0, info: 0, pass: 0 };
  for (const finding of report.findings) counts[finding.severity] += 1;

  const container = h("div", { class: "stack" }, [
    h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("div", {}, [
          h("h2", { text: `Results for ${report.domain}`, tabindex: "-1", id: "health-results" }),
          h("p", {
            class: "small muted",
            text: `Checked ${formatDate(report.checkedAt)}${report.dkimSelector ? ` · DKIM selector “${report.dkimSelector}”` : " · DKIM selector not supplied"}`,
          }),
        ]),
        badge(
          report.status === "ok"
            ? "DNS checks completed"
            : report.status === "partial"
              ? "Partially completed"
              : "DNS checks failed",
          report.status === "failed" ? "failed" : report.status === "partial" ? "warning" : "pass",
        ),
      ]),
      h("div", { class: "stat-grid" }, [
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Critical" }),
          h("span", { class: "stat-value", text: String(counts.critical) }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Warnings" }),
          h("span", { class: "stat-value", text: String(counts.warning) }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Passing" }),
          h("span", { class: "stat-value", text: String(counts.pass) }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Informational" }),
          h("span", { class: "stat-value", text: String(counts.info) }),
        ]),
      ]),
      report.status === "partial"
        ? alertBox("warning", "Some DNS queries could not be completed", [
            h("p", {
              text: "Findings based on failed lookups are marked inconclusive. Retry before changing DNS records.",
            }),
          ])
        : report.status === "failed"
          ? alertBox("danger", "No DNS query completed successfully", [
              h("p", {
                text: "This usually indicates a resolver, network, or domain-existence problem. The report cannot confirm a mail configuration fault.",
              }),
            ])
          : null,
      h("p", {
        class: "small muted",
        text: "DNS configuration is one input to deliverability. It does not prove inbox placement, sender reputation, or mail-server health, and MailSentry does not send test messages.",
      }),
    ]),
    ...CHECKS.map((check) => {
      const findings = report.findings.filter((finding) => finding.check === check.id);
      return h("section", { class: "check-group", "aria-labelledby": `check-${check.id}` }, [
        h("h3", { id: `check-${check.id}` }, [
          `${check.label} — ${check.description}`,
          badge(
            findings.some((finding) => finding.severity === "critical")
              ? "Critical"
              : findings.some((finding) => finding.severity === "warning")
                ? "Review"
                : "Checked",
            findings.some((finding) => finding.severity === "critical")
              ? "critical"
              : findings.some((finding) => finding.severity === "warning")
                ? "warning"
                : "pass",
          ),
        ]),
        ...(findings.length > 0
          ? findings.map(findingNode)
          : [h("p", { class: "muted small", text: "No findings were produced for this check." })]),
      ]);
    }),
    h("details", {}, [
      h("summary", { text: "Raw DNS observations" }),
      ...CHECKS.map((check) => {
        const values = report.observations[check.id] ?? [];
        return h("div", {}, [
          h("h4", { text: check.label }),
          values.length > 0
            ? h(
                "ul",
                { class: "small" },
                values.map((value) => h("li", {}, [h("code", { text: value })])),
              )
            : h("p", { class: "small muted", text: "No observation recorded." }),
        ]);
      }),
    ]),
    h("details", {}, [
      h("summary", { text: "Diagnostic limitations and scope" }),
      h(
        "ul",
        { class: "small" },
        report.limitations.map((limitation) => h("li", { text: limitation })),
      ),
    ]),
  ]);
  return container;
}

export const renderHealth: View = (root, context) => {
  let controller: AbortController | null = null;
  let busy = false;

  const statusLine = h("p", { class: "hint", role: "status", "aria-live": "polite" });
  const errorSlot = h("div", {});
  const resultSlot = h("div", {});

  const domainInput = h("input", {
    type: "text",
    id: "domain",
    name: "domain",
    required: true,
    autocomplete: "off",
    spellcheck: false,
    placeholder: "example.com",
    value: remembered?.domain ?? "",
    "aria-describedby": "domain-hint",
  });
  const selectorInput = h("input", {
    type: "text",
    id: "dkim-selector",
    name: "dkimSelector",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "e.g. 20230601",
    value: remembered?.selector ?? "",
    "aria-describedby": "selector-hint",
  });

  const submit = h("button", { class: "btn btn-primary", type: "submit", text: "Run DNS checks" });
  const cancel = h("button", { class: "btn", type: "button", text: "Cancel", hidden: true });

  const form = h("form", { class: "card", novalidate: true }, [
    h("div", { class: "card-head" }, [
      h("h2", { text: "Check a domain" }),
      h("span", { class: "pill", text: "Public DNS · read-only" }),
    ]),
    h("div", { class: "field" }, [
      h("label", { for: "domain", text: "Domain" }),
      domainInput,
      h("p", {
        class: "hint",
        id: "domain-hint",
        text: "A public domain name, not an email address. Internal, local, and IP-literal targets are rejected.",
      }),
    ]),
    h("div", { class: "field" }, [
      h("label", { for: "dkim-selector", text: "DKIM selector (optional)" }),
      selectorInput,
      h("p", {
        class: "hint",
        id: "selector-hint",
        text: "DKIM keys live at <selector>._domainkey.<domain>. MailSentry does not guess selectors. Find yours in a recent DKIM-Signature header or provider documentation.",
      }),
    ]),
    h("div", { class: "btn-row" }, [submit, cancel]),
    statusLine,
    errorSlot,
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    const domain = domainInput.value.trim();
    const selector = selectorInput.value.trim();
    if (!domain) {
      domainInput.setAttribute("aria-invalid", "true");
      domainInput.focus();
      clear(errorSlot);
      errorSlot.append(alertBox("danger", "Enter a domain to check.", []));
      return;
    }
    domainInput.removeAttribute("aria-invalid");
    clear(errorSlot);
    busy = true;
    controller = new AbortController();
    submit.disabled = true;
    cancel.hidden = false;
    statusLine.textContent = "Querying public DNS records. This performs a small, fixed set of lookups.";
    clear(resultSlot);

    void runDiagnostics(domain, selector, controller.signal)
      .then((report) => {
        remembered = { domain, selector, report };
        statusLine.textContent = `Completed ${formatDate(report.checkedAt)}.`;
        resultSlot.append(reportNode(report));
        const heading = document.getElementById("health-results");
        heading?.focus();
        void context.refreshStatus().catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (controller?.signal.aborted) {
          statusLine.textContent = "Check cancelled.";
          return;
        }
        statusLine.textContent = "";
        clear(errorSlot);
        const message = error instanceof ApiError ? error.message : "The diagnostic check failed.";
        errorSlot.append(alertBox("danger", "Could not complete the check", [h("p", { text: message })]));
      })
      .finally(() => {
        busy = false;
        submit.disabled = false;
        cancel.hidden = true;
        controller = null;
      });
  });

  cancel.addEventListener("click", () => {
    controller?.abort();
    statusLine.textContent = "Cancelling…";
  });

  root.append(
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("div", { class: "eyebrow", text: "Email infrastructure" }),
        h("h1", { text: "Email Health" }),
        h("p", {
          text: "Inspect MX, SPF, DKIM, and DMARC records for a domain. Results are point-in-time observations with explicit confidence levels — not a guarantee of delivery or inbox placement.",
        }),
      ]),
    ]),
    form,
    h("p", {
      class: "small muted",
      text: "MailSentry never changes DNS records and never sends email. It queries only MX and TXT records for the domain and DKIM selector you provide.",
    }),
    h("div", { class: "section" }, [resultSlot]),
  );

  if (remembered) {
    statusLine.textContent = `Showing the previous check from ${formatDate(remembered.report.checkedAt)}.`;
    resultSlot.append(reportNode(remembered.report));
  }

  return () => {
    controller?.abort();
  };
};
