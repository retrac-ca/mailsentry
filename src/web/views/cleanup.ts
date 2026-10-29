import type {
  CleanupAction,
  CleanupFilters,
  CleanupJob,
  CleanupPreview,
  FolderKind,
  ProviderCapabilities,
  ProviderConnectionStatus,
  ProviderId,
} from "../../shared/types.js";
import { ApiError, cancelJob, executePlan, getJob, scanMailbox, startAuth } from "../api.js";
import type { AppContext, View } from "../context.js";
import { alertBox, append, badge, h } from "../dom.js";
import {
  actionName,
  folderName,
  formatBytes,
  formatDate,
  formatNumber,
  plural,
  providerName,
} from "../format.js";

interface CleanupState {
  provider: ProviderId | null;
  folders: FolderKind[];
  action: CleanupAction | "";
  minAgeDays: string;
  minSizeMb: string;
  largeAttachmentMb: string;
  bulkOnly: boolean;
  includeStarred: boolean;
  includeUnread: boolean;
  includeImportant: boolean;
  senderTargets: string;
  senderAllowlist: string;
  preview: CleanupPreview | null;
  job: CleanupJob | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

function defaultState(): CleanupState {
  return {
    provider: null,
    folders: [],
    action: "",
    minAgeDays: "365",
    minSizeMb: "",
    largeAttachmentMb: "",
    bulkOnly: false,
    includeStarred: false,
    includeUnread: false,
    includeImportant: false,
    senderTargets: "",
    senderAllowlist: "",
    preview: null,
    job: null,
    busy: false,
    error: null,
    notice: null,
  };
}

let state: CleanupState = defaultState();
let scanController: AbortController | null = null;
let pollTimer: number | null = null;
let pollFailures = 0;
let viewActive = false;

const ACTION_HELP: Record<CleanupAction, string> = {
  archive:
    "Removes the Inbox label only. Messages stay in the mailbox and can be found in All Mail or Archive.",
  trash: "Moves messages to Trash / Deleted Items. Recovery depends on the provider's retention policy.",
  permanentDelete: "Permanently deletes messages. This cannot be undone by MailSentry.",
  emptyTrash:
    "Permanently deletes eligible messages currently in Trash. Filters are ignored; protections still apply.",
};

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function parseSenderList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function actionAvailability(
  action: CleanupAction,
  folders: FolderKind[],
  capabilities: ProviderCapabilities,
): boolean {
  if (!capabilities.actions[action].supported) return false;
  if (folders.length === 0) return false;
  if (action === "archive") return folders.length === 1 && folders[0] === "inbox";
  if (action === "trash") return !folders.includes("trash");
  if (action === "emptyTrash") return folders.length === 1 && folders[0] === "trash";
  return true;
}

function buildFilters(): { filters: CleanupFilters; error: string | null } {
  const age = state.minAgeDays.trim() === "" ? 0 : Number(state.minAgeDays);
  if (!Number.isFinite(age) || age < 0 || age > 36_500) {
    return { filters: {} as CleanupFilters, error: "Minimum age must be between 0 and 36500 days." };
  }
  const sizeMb = state.minSizeMb.trim() === "" ? null : Number(state.minSizeMb);
  if (sizeMb !== null && (!Number.isFinite(sizeMb) || sizeMb < 0)) {
    return {
      filters: {} as CleanupFilters,
      error: "Minimum size must be a non-negative number of megabytes.",
    };
  }
  const attachmentMb = state.largeAttachmentMb.trim() === "" ? null : Number(state.largeAttachmentMb);
  if (attachmentMb !== null && (!Number.isFinite(attachmentMb) || attachmentMb < 0)) {
    return {
      filters: {} as CleanupFilters,
      error: "Attachment size must be a non-negative number of megabytes.",
    };
  }
  const filters: CleanupFilters = {
    minAgeDays: age,
    minSizeBytes: sizeMb === null ? null : Math.round(sizeMb * 1024 * 1024),
    largeAttachmentBytes: attachmentMb === null ? null : Math.round(attachmentMb * 1024 * 1024),
    bulkOnly: state.bulkOnly,
    senderAllowlist: parseSenderList(state.senderAllowlist),
    senderTargets: parseSenderList(state.senderTargets),
    includeStarred: state.includeStarred,
    includeUnread: state.includeUnread,
    includeImportant: state.includeImportant,
  };
  if (state.action !== "emptyTrash") {
    const hasCriterion =
      filters.minAgeDays > 0 ||
      filters.minSizeBytes !== null ||
      filters.largeAttachmentBytes !== null ||
      filters.bulkOnly ||
      filters.senderTargets.length > 0;
    if (!hasCriterion) {
      return {
        filters,
        error:
          "Enable at least one filter — age, size, attachment size, bulk mail, or targeted senders — so a whole folder is never selected by accident.",
      };
    }
  }
  return { filters, error: null };
}

function statusChip(provider: ProviderConnectionStatus): HTMLElement {
  if (!provider.configured) return badge("Not configured", "planned");
  if (!provider.connected) return badge("Ready to connect", "info");
  return badge(
    provider.mode === "cleanup" ? "Cleanup access" : "Read-only",
    provider.mode === "cleanup" ? "warning" : "pass",
  );
}

function providerCard(
  provider: ProviderConnectionStatus,
  selected: boolean,
  context: AppContext,
): HTMLElement {
  const actions: HTMLElement[] = [];
  const fail = (message: string) => {
    state.error = message;
    state.busy = false;
    context.rerender();
  };
  const connect = (mode: "readonly" | "cleanup", label: string) => {
    const button = h("button", {
      class: "btn btn-small",
      type: "button",
      text: label,
      on: {
        click: () => {
          button.disabled = true;
          button.textContent = "Opening authorization…";
          void startAuth(provider.provider, mode)
            .then((url) => window.location.assign(url))
            .catch((error: unknown) => {
              button.disabled = false;
              button.textContent = label;
              fail(error instanceof ApiError ? error.message : "Could not start authorization.");
            });
        },
      },
    });
    actions.push(button);
  };

  if (provider.connected) {
    if (!selected) {
      actions.push(
        h("button", {
          class: "btn btn-small btn-primary",
          type: "button",
          text: "Use this account",
          on: {
            click: () => {
              state.provider = provider.provider;
              state.preview = null;
              state.job = null;
              state.error = null;
              context.rerender();
            },
          },
        }),
      );
    }
    if (provider.mode === "readonly") connect("cleanup", "Connect cleanup access");
  } else if (provider.configured) {
    connect("readonly", "Connect read-only");
    connect("cleanup", "Connect cleanup access");
  }

  return h("div", { class: `provider-card${selected ? " selected" : ""}` }, [
    h("h3", {}, [provider.displayName, statusChip(provider)]),
    h("p", { class: "small muted" }, [
      provider.connected
        ? `${provider.account ?? "Connected"} · since ${formatDate(provider.connectedAt)}`
        : provider.configured
          ? "Connect with read-only access for scans and previews, or cleanup access to execute changes."
          : provider.setupHint,
    ]),
    actions.length > 0 ? h("div", { class: "provider-actions" }, actions) : null,
  ]);
}

function currentStep(providerConnected: boolean): number {
  if (state.job) return 4;
  if (state.preview) return 3;
  if (providerConnected) return 2;
  return 1;
}

function stepsNode(step: number): HTMLElement {
  const labels = ["Connect & select", "Folders & filters", "Review preview", "Execute & results"];
  return h(
    "ol",
    { class: "steps", "aria-label": "Cleanup workflow" },
    labels.map((label, index) => {
      const number = index + 1;
      const className = number === step ? "active" : number < step ? "done" : "";
      return h("li", { class: className, "aria-current": number === step ? "step" : undefined }, [
        h("span", { text: label }),
      ]);
    }),
  );
}

function folderChecks(provider: ProviderConnectionStatus, context: AppContext): HTMLElement {
  return h("fieldset", {}, [
    h("legend", { text: "Folders (independent selection)" }),
    h("p", {
      class: "hint",
      text: "Nothing is selected by default. Selecting one folder never selects the others.",
    }),
    h(
      "ul",
      { class: "check-list" },
      (["inbox", "spam", "trash"] as FolderKind[]).map((folder) => {
        const capability = provider.capabilities.folders[folder];
        const checkbox = h("input", {
          type: "checkbox",
          id: `folder-${folder}`,
          checked: state.folders.includes(folder),
          disabled: !capability.supported,
          on: {
            change: (event) => {
              const checked = (event.target as HTMLInputElement).checked;
              state.folders = checked
                ? [...new Set([...state.folders, folder])]
                : state.folders.filter((entry) => entry !== folder);
              if (state.action && !actionAvailability(state.action, state.folders, provider.capabilities)) {
                state.action = "";
              }
              state.preview = null;
              state.job = null;
              state.error = null;
              context.rerender();
              window.requestAnimationFrame(() => document.getElementById(`folder-${folder}`)?.focus());
            },
          },
        });
        return h("li", {}, [
          h("label", { class: "check", for: `folder-${folder}` }, [
            checkbox,
            h("span", { class: "check-text" }, [
              h("strong", { text: capability.displayName }),
              h("span", {
                text: capability.supported
                  ? folder === "inbox"
                    ? "Incoming mail. Archive targets this folder."
                    : folder === "spam"
                      ? "Provider-classified spam/junk. Never included unless selected."
                      : "Trash/deleted items. Permanent actions are available only where the provider supports them."
                  : (capability.reason ?? "Unsupported by this provider."),
              }),
            ]),
          ]),
        ]);
      }),
    ),
  ]);
}

function actionField(provider: ProviderConnectionStatus, context: AppContext): HTMLElement {
  const options = (["archive", "trash", "permanentDelete", "emptyTrash"] as CleanupAction[]).map((action) => {
    const capability = provider.capabilities.actions[action];
    const available = actionAvailability(action, state.folders, provider.capabilities);
    return h("option", {
      value: action,
      selected: state.action === action,
      disabled: !available,
      text: `${actionName(action)}${!capability.supported ? " (unsupported)" : ""}`,
    });
  });
  const select = h(
    "select",
    {
      id: "cleanup-action",
      on: {
        change: (event) => {
          state.action = (event.target as HTMLSelectElement).value as CleanupAction | "";
          state.preview = null;
          state.job = null;
          state.error = null;
          context.rerender();
          window.requestAnimationFrame(() => document.getElementById("cleanup-action")?.focus());
        },
      },
    },
    [h("option", { value: "", text: "Select an action…" }), ...options],
  );

  const selected = state.action ? provider.capabilities.actions[state.action] : null;
  return h("div", { class: "field" }, [
    h("label", { for: "cleanup-action", text: "Proposed action" }),
    select,
    state.action
      ? h("p", { class: "hint" }, [
          ACTION_HELP[state.action],
          " ",
          selected?.confirmationRequired
            ? "Irreversible actions require a separate typed confirmation and are disabled for providers without safe support."
            : "Review the preview before executing.",
        ])
      : h("p", {
          class: "hint",
          text: "Choose the action only after selecting folders. No action is preselected.",
        }),
    state.action === "emptyTrash"
      ? alertBox("warning", "Empty Trash is permanent", [
          h("p", {
            text: "Age, size, and bulk filters are ignored for Empty Trash. Allowlist and protection rules still apply. Deletion cannot be undone by MailSentry.",
          }),
        ])
      : null,
    state.action === "permanentDelete"
      ? alertBox("danger", "Permanent deletion is irreversible", [
          h("p", {
            text: "Provider retention and recovery are not guaranteed. A second confirmation is required after review.",
          }),
        ])
      : null,
  ]);
}

function filtersFieldset(provider: ProviderConnectionStatus): HTMLElement {
  const update = () => {
    state.preview = null;
    state.job = null;
    state.error = null;
  };
  const ageInput = h("input", {
    type: "number",
    id: "min-age",
    min: "0",
    max: "36500",
    step: "1",
    value: state.minAgeDays,
    on: {
      input: (event) => {
        state.minAgeDays = (event.target as HTMLInputElement).value;
        update();
      },
    },
  });
  const sizeInput = h("input", {
    type: "number",
    id: "min-size",
    min: "0",
    step: "0.1",
    placeholder: "No size filter",
    value: state.minSizeMb,
    on: {
      input: (event) => {
        state.minSizeMb = (event.target as HTMLInputElement).value;
        update();
      },
    },
  });
  const targetInput = h("textarea", {
    id: "sender-targets",
    placeholder: "newsletters.example, notices@example.com",
    value: state.senderTargets,
    on: {
      input: (event) => {
        state.senderTargets = (event.target as HTMLTextAreaElement).value;
        update();
      },
    },
  });
  const allowInput = h("textarea", {
    id: "sender-allowlist",
    placeholder: "ceo@example.com, bank.example",
    value: state.senderAllowlist,
    on: {
      input: (event) => {
        state.senderAllowlist = (event.target as HTMLTextAreaElement).value;
        update();
      },
    },
  });
  const checkbox = (
    id: string,
    label: string,
    description: string,
    checked: boolean,
    onChange: (value: boolean) => void,
  ) => {
    const input = h("input", {
      type: "checkbox",
      id,
      checked,
      on: {
        change: (event) => {
          onChange((event.target as HTMLInputElement).checked);
          update();
        },
      },
    });
    return h("li", {}, [
      h("label", { class: "check", for: id }, [
        input,
        h("span", { class: "check-text" }, [h("strong", { text: label }), h("span", { text: description })]),
      ]),
    ]);
  };

  return h("fieldset", {}, [
    h("legend", { text: "Cleanup filters (conservative defaults)" }),
    h("div", { class: "inline-fields" }, [
      h("div", { class: "field" }, [
        h("label", { for: "min-age", text: "Older than (days)" }),
        ageInput,
        h("p", { class: "hint", text: "365 days by default. Use 0 to disable the age filter." }),
      ]),
      h("div", { class: "field" }, [
        h("label", { for: "min-size", text: "Larger than (MB)" }),
        sizeInput,
        h("p", { class: "hint", text: "Uses provider-reported message size. Blank disables." }),
      ]),
    ]),
    provider.capabilities.metadata.attachmentSize
      ? h("div", { class: "field" }, [
          h("label", { for: "large-attachment", text: "Large attachments (MB)" }),
          h("input", {
            type: "number",
            id: "large-attachment",
            min: "0",
            step: "0.1",
            value: state.largeAttachmentMb,
            on: {
              input: (event) => {
                state.largeAttachmentMb = (event.target as HTMLInputElement).value;
                update();
              },
            },
          }),
        ])
      : h("p", {
          class: "hint",
          text: "Attachment-size filtering is unavailable for this provider because message listings do not expose reliable attachment sizes. MailSentry will not guess.",
        }),
    h("ul", { class: "check-list" }, [
      checkbox(
        "bulk-only",
        "Potential newsletters and bulk mail",
        "Uses mailing-list headers where available. Uncertain classifications are excluded from eligibility.",
        state.bulkOnly,
        (value) => {
          state.bulkOnly = value;
        },
      ),
    ]),
    h("div", { class: "field" }, [
      h("label", { for: "sender-targets", text: "Only these senders/domains (optional)" }),
      targetInput,
      h("p", {
        class: "hint",
        text: "One address or domain per line, or comma-separated. Leave blank to allow any sender.",
      }),
    ]),
    h("div", { class: "field" }, [
      h("label", { for: "sender-allowlist", text: "Never clean these senders/domains" }),
      allowInput,
      h("p", { class: "hint", text: "Allowlisted senders are excluded even if every other filter matches." }),
    ]),
    h("fieldset", {}, [
      h("legend", { text: "Protection overrides" }),
      h("p", {
        class: "hint",
        text: "By default, starred, unread, and important messages are protected and never eligible.",
      }),
      h("ul", { class: "check-list" }, [
        checkbox(
          "include-starred",
          "Include starred messages",
          "Removes the starred protection. This can delete messages you marked deliberately.",
          state.includeStarred,
          (value) => {
            state.includeStarred = value;
          },
        ),
        checkbox(
          "include-unread",
          "Include unread messages",
          "Removes the unread protection. Old unread mail may still be important.",
          state.includeUnread,
          (value) => {
            state.includeUnread = value;
          },
        ),
        checkbox(
          "include-important",
          "Include important messages",
          "Removes the important-marker protection where the provider exposes it.",
          state.includeImportant,
          (value) => {
            state.includeImportant = value;
          },
        ),
      ]),
    ]),
    h("p", {
      class: "hint",
      text: "Filters are applied server-side during the scan and re-applied to each message before execution. Scans read metadata only.",
    }),
  ]);
}

function scanPanel(provider: ProviderConnectionStatus, context: AppContext): HTMLElement {
  const scanButton = h("button", {
    class: "btn btn-primary",
    type: "button",
    text: state.busy ? "Scanning…" : "Scan mailbox (read-only)",
    disabled: state.busy,
    on: {
      click: () => {
        if (!state.action) {
          state.error = "Select a proposed action before scanning.";
          context.rerender();
          return;
        }
        if (state.folders.length === 0) {
          state.error = "Select at least one folder — nothing is selected by default.";
          context.rerender();
          return;
        }
        const { filters, error } = buildFilters();
        if (error) {
          state.error = error;
          context.rerender();
          return;
        }
        state.error = null;
        state.notice = null;
        state.busy = true;
        scanController = new AbortController();
        context.rerender();
        void scanMailbox(
          {
            provider: provider.provider,
            folders: state.folders,
            filters,
            action: state.action as CleanupAction,
          },
          scanController.signal,
        )
          .then((preview) => {
            state.preview = preview;
            state.job = null;
            state.busy = false;
            scanController = null;
            state.notice = `Scanned ${formatNumber(preview.scannedCount)} messages. Nothing was changed.`;
            return context.refreshStatus();
          })
          .then(() => context.rerender())
          .then(() => {
            document.getElementById("preview-heading")?.focus();
          })
          .catch((error: unknown) => {
            if (scanController?.signal.aborted) {
              state.notice = "Scan cancelled. Nothing was changed.";
            } else {
              state.error = error instanceof ApiError ? error.message : "The scan failed.";
            }
            state.busy = false;
            scanController = null;
            context.rerender();
          });
      },
    },
  });

  const cancelScan = state.busy
    ? h("button", {
        class: "btn",
        type: "button",
        text: "Cancel scan",
        on: {
          click: () => {
            scanController?.abort();
            state.notice = "Cancelling scan…";
            context.rerender();
          },
        },
      })
    : null;

  const readonly = provider.mode === "readonly";

  return h("section", { class: "card", "aria-labelledby": "cleanup-criteria" }, [
    h("div", { class: "card-head" }, [
      h("h2", { id: "cleanup-criteria", text: "Folders, filters, and action" }),
      readonly ? badge("Read-only connection", "info") : badge("Cleanup access", "warning"),
    ]),
    folderChecks(provider, context),
    actionField(provider, context),
    filtersFieldset(provider),
    h("div", { class: "btn-row" }, [scanButton, cancelScan]),
    readonly
      ? h("p", {
          class: "hint",
          text: "This account can scan and dry-run but cannot execute changes. Reconnect with cleanup access when you are ready to review and execute.",
        })
      : null,
    h("p", {
      class: "hint",
      text: "Scanning and previews are strictly read-only. Scanning runs only when you press the button.",
    }),
  ]);
}

function previewPanel(
  preview: CleanupPreview,
  provider: ProviderConnectionStatus,
  context: AppContext,
): HTMLElement {
  const readonly = provider.mode === "readonly";
  const none = preview.eligibleCount === 0;
  const jobActive = state.job?.status === "running" || state.job?.status === "queued";
  const actionInfo = preview.actionInfo;

  const dryRun = h("button", {
    class: "btn",
    type: "button",
    text: "Dry run (no changes)",
    disabled: state.busy || none || jobActive,
    on: {
      click: () => {
        void runExecution(context, "dry-run");
      },
    },
  });
  const execute = h("button", {
    class: `btn ${actionInfo.destructive ? "btn-danger" : "btn-primary"}`,
    type: "button",
    text: `Execute: ${actionInfo.label}`,
    disabled:
      state.busy || none || readonly || jobActive || !provider.capabilities.actions[preview.action].supported,
    on: {
      click: () => openConfirmation(preview, context),
    },
  });
  const startOver = h("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Start over",
    on: {
      click: () => {
        stopPolling();
        state.preview = null;
        state.job = null;
        state.error = null;
        state.notice = null;
        context.rerender();
      },
    },
  });

  return h("section", { class: "section", "aria-labelledby": "preview-heading" }, [
    h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("div", {}, [
          h("h2", { id: "preview-heading", tabindex: "-1", text: "Review the cleanup plan" }),
          h("p", {
            class: "small muted",
            text: `Plan created ${formatDate(preview.createdAt)} · expires ${formatDate(preview.expiresAt)}`,
          }),
        ]),
        badge(
          actionInfo.destructive ? "Irreversible" : "Reversible",
          actionInfo.destructive ? "failed" : "pass",
        ),
      ]),
      h("div", { class: "stat-grid" }, [
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Scanned" }),
          h("span", { class: "stat-value", text: formatNumber(preview.scannedCount) }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Eligible" }),
          h("span", { class: "stat-value", text: formatNumber(preview.eligibleCount) }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Uncertain (excluded)" }),
          h("span", { class: "stat-value", text: formatNumber(preview.uncertainCount) }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Eligible size" }),
          h("span", { class: "stat-value", text: formatBytes(preview.eligibleBytes) }),
        ]),
      ]),
      h("dl", { class: "kv" }, [
        h("dt", { text: "Provider" }),
        h("dd", { text: providerName(preview.provider) }),
        h("dt", { text: "Components" }),
        h("dd", { text: preview.folders.map(folderName).join(", ") }),
        h("dt", { text: "Action" }),
        h("dd", { text: actionInfo.label }),
        h("dt", { text: "What will happen" }),
        h("dd", { text: actionInfo.description }),
        h("dt", { text: "Storage recovery" }),
        h("dd", {
          text:
            preview.action === "permanentDelete" || preview.action === "emptyTrash"
              ? `${formatBytes(preview.eligibleBytes)} (provider estimate; actual recovery may differ)`
              : "No immediate storage recovery. Archiving and Trash moves do not free storage.",
        }),
      ]),
      h("div", { class: "table-wrap" }, [
        h("table", {}, [
          h("caption", { text: "Eligible messages by folder" }),
          h("thead", {}, [
            h(
              "tr",
              {},
              ["Folder", "Scanned", "Eligible", "Uncertain", "Size"].map((label) =>
                h("th", { scope: "col", text: label }),
              ),
            ),
          ]),
          h(
            "tbody",
            {},
            preview.byFolder.map((row) =>
              h("tr", {}, [
                h("td", { text: row.displayName }),
                h("td", { text: formatNumber(row.scanned) }),
                h("td", { text: formatNumber(row.eligible) }),
                h("td", { text: formatNumber(row.uncertain) }),
                h("td", { text: formatBytes(row.bytes) }),
              ]),
            ),
          ),
        ]),
      ]),
      preview.warnings.length > 0
        ? h(
            "div",
            {},
            preview.warnings.map((warning) =>
              alertBox("warning", "Review note", [h("p", { text: warning })]),
            ),
          )
        : null,
      h("h3", { text: "Candidate sample" }),
      preview.sample.length === 0
        ? h("p", { class: "muted", text: "No eligible or uncertain messages were retained for the sample." })
        : h("div", { class: "table-wrap" }, [
            h("table", {}, [
              h("caption", {
                text: `Metadata sample${preview.sampleTruncated ? " (truncated)" : ""}. Full message bodies were not fetched.`,
              }),
              h("thead", {}, [
                h(
                  "tr",
                  {},
                  ["Subject", "From", "Received", "Size", "Bulk", "Status"].map((label) =>
                    h("th", { scope: "col", text: label }),
                  ),
                ),
              ]),
              h(
                "tbody",
                {},
                preview.sample.map((message) =>
                  h("tr", {}, [
                    h("td", { class: "wrap", text: message.subject ?? "(no subject)" }),
                    h("td", { class: "wrap", text: message.from ?? "—" }),
                    h("td", { class: "nowrap", text: formatDate(message.receivedAt) }),
                    h("td", { class: "nowrap", text: formatBytes(message.sizeBytes) }),
                    h("td", { text: message.bulk.level }),
                    h("td", {}, [
                      message.uncertain
                        ? badge("Uncertain — excluded", "warning")
                        : badge("Eligible", "pass"),
                    ]),
                  ]),
                ),
              ),
            ]),
          ]),
      h("details", {}, [
        h("summary", { text: "Provider limitations" }),
        h(
          "ul",
          { class: "small" },
          preview.limitations.map((limitation) => h("li", { text: limitation })),
        ),
      ]),
      h("div", { class: "btn-row" }, [dryRun, execute, startOver]),
      readonly
        ? h("p", {
            class: "hint",
            text: "Execution is disabled because this account is connected read-only. Dry run is available.",
          })
        : null,
      actionInfo.destructive
        ? h("p", {
            class: "hint",
            text: `Permanent deletion requires typing “${actionInfo.confirmationPhrase}” in a separate confirmation. Completion is not a promise that data can be recovered.`,
          })
        : null,
      none
        ? h("p", { class: "hint", text: "No messages matched. Nothing can be executed from this preview." })
        : null,
    ]),
  ]);
}

function openConfirmation(preview: CleanupPreview, context: AppContext): void {
  const destructive = preview.actionInfo.destructive;
  const phrase = preview.actionInfo.confirmationPhrase ?? "";
  let phraseInput: HTMLInputElement | null = null;
  const confirmButton = h("button", {
    class: "btn btn-danger",
    type: "button",
    text: destructive ? "Permanently delete" : `Confirm ${preview.actionInfo.label}`,
    disabled: destructive,
  });
  const cancelButton = h("button", {
    class: "btn",
    type: "button",
    text: "Cancel",
  });
  const dialog = h("dialog", { "aria-labelledby": "confirm-title" }, [
    h("h2", { id: "confirm-title", text: `Confirm: ${preview.actionInfo.label}` }),
    h("p", { text: preview.actionInfo.description }),
    h("dl", { class: "kv" }, [
      h("dt", { text: "Provider" }),
      h("dd", { text: providerName(preview.provider) }),
      h("dt", { text: "Folders" }),
      h("dd", { text: preview.folders.map(folderName).join(", ") }),
      h("dt", { text: "Messages" }),
      h("dd", { text: plural(preview.eligibleCount, "message") }),
      h("dt", { text: "Estimated size" }),
      h("dd", { text: formatBytes(preview.eligibleBytes) }),
    ]),
    destructive
      ? h("div", { class: "alert danger" }, [
          h("p", {
            text: "This action permanently deletes messages. It cannot be undone by MailSentry, and recovery is not guaranteed.",
          }),
          h("div", { class: "field" }, [
            h("label", { for: "confirm-phrase", text: `Type “${phrase}” to confirm` }),
            h("input", {
              type: "text",
              id: "confirm-phrase",
              autocomplete: "off",
              spellcheck: false,
              on: {
                input: (event) => {
                  phraseInput = event.target as HTMLInputElement;
                  confirmButton.disabled = phraseInput.value !== phrase;
                },
              },
            }),
          ]),
        ])
      : h("p", {
          class: "small muted",
          text: "The server will revalidate every message against this plan before changing it.",
        }),
    h("div", { class: "dialog-actions" }, [cancelButton, confirmButton]),
  ]);

  cancelButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  confirmButton.addEventListener("click", () => {
    const typed = phraseInput?.value ?? "";
    dialog.close();
    void runExecution(context, "execute", destructive ? typed : undefined);
  });

  document.body.append(dialog);
  dialog.showModal();
  if (destructive) {
    dialog.querySelector<HTMLInputElement>("#confirm-phrase")?.focus();
  } else {
    confirmButton.focus();
  }
}

async function runExecution(
  context: AppContext,
  mode: "dry-run" | "execute",
  confirmation?: string,
): Promise<void> {
  const preview = state.preview;
  if (!preview) return;
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  state.notice = null;
  context.rerender();
  try {
    const job = await executePlan({
      planId: preview.planId,
      planHash: preview.planHash,
      reviewToken: preview.reviewToken,
      mode,
      ...(confirmation !== undefined ? { confirmation } : {}),
    });
    state.job = job;
    if (mode === "execute") state.preview = null;
    state.notice =
      mode === "dry-run"
        ? "Dry run started. No changes will be made."
        : "Execution started. Completed operations are reported as they finish.";
  } catch (error) {
    state.error = error instanceof ApiError ? error.message : "The cleanup job could not be started.";
    if (error instanceof ApiError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) {
      state.preview = null;
      state.error = `${state.error} Scan again and review the new preview.`;
    }
  } finally {
    state.busy = false;
    context.rerender();
  }
}

function jobPanel(job: CleanupJob, context: AppContext): HTMLElement {
  const running = job.status === "running" || job.status === "queued";
  const cancelButton = h("button", {
    class: "btn",
    type: "button",
    text: "Cancel execution",
    disabled: !running,
    id: "cleanup-cancel",
    on: {
      click: () => {
        cancelButton.disabled = true;
        cancelButton.textContent = "Cancelling…";
        void cancelJob(job.id)
          .then((updated) => {
            state.job = updated;
            state.notice = "Cancellation requested. Completed operations are not rolled back.";
            context.rerender();
          })
          .catch((error: unknown) => {
            cancelButton.disabled = false;
            cancelButton.textContent = "Cancel execution";
            state.error = error instanceof ApiError ? error.message : "Could not request cancellation.";
            context.rerender();
          });
      },
    },
  });

  const progressValue = job.progress.processed;
  const results = job.results;

  return h("section", { class: "section", "aria-labelledby": "job-heading" }, [
    h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("div", {}, [
          h("h2", {
            id: "job-heading",
            tabindex: "-1",
            text: job.mode === "dry-run" ? "Dry run results" : "Execution results",
          }),
          h("p", {
            class: "small muted",
            text: `${job.mode === "dry-run" ? "Simulation" : "Execution"} · ${providerName(job.provider)} · ${actionName(job.action)}`,
          }),
        ]),
        badge(
          job.status === "completed"
            ? "Completed"
            : job.status === "cancelled"
              ? "Cancelled"
              : job.status === "failed"
                ? "Failed"
                : "Running",
          job.status === "completed" ? "pass" : job.status === "failed" ? "failed" : "warning",
        ),
      ]),
      job.mode === "dry-run"
        ? alertBox("info", "No changes were made", [
            h("p", {
              text: "This dry run read and revalidated message metadata. It did not archive, move, or delete anything. Success counts are simulated.",
            }),
          ])
        : null,
      running
        ? h("div", { class: "progress-block" }, [
            h("div", { class: "progress-label" }, [
              h("span", {
                id: "cleanup-progress-label",
                text: `${formatNumber(progressValue)} of ${formatNumber(job.total)} processed`,
              }),
              h("span", { text: `Batch ${job.batchSize} · concurrency ${job.concurrency}` }),
            ]),
            h("progress", {
              id: "cleanup-progress",
              max: Math.max(1, job.total),
              value: progressValue,
              "aria-label": "Cleanup progress",
            }),
          ])
        : null,
      h("div", { class: "stat-grid" }, [
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Processed" }),
          h("span", {
            class: "stat-value",
            text: `${formatNumber(job.progress.processed)} / ${formatNumber(job.total)}`,
          }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Succeeded" }),
          h("span", {
            class: "stat-value",
            id: "cleanup-succeeded",
            text: formatNumber(job.progress.succeeded),
          }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Failed" }),
          h("span", { class: "stat-value", id: "cleanup-failed", text: formatNumber(job.progress.failed) }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Skipped (changed)" }),
          h("span", {
            class: "stat-value",
            id: "cleanup-skipped",
            text: formatNumber(job.progress.skippedChanged),
          }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Uncertain" }),
          h("span", {
            class: "stat-value",
            id: "cleanup-uncertain",
            text: formatNumber(job.progress.uncertain),
          }),
        ]),
        h("div", { class: "stat" }, [
          h("span", { class: "stat-label", text: "Storage freed" }),
          h("span", { class: "stat-value", text: formatBytes(job.progress.bytesRecovered) }),
        ]),
      ]),
      job.error ? alertBox("danger", "Job stopped with an error", [h("p", { text: job.error })]) : null,
      job.warnings.length > 0
        ? h(
            "div",
            {},
            job.warnings.map((warning) => alertBox("warning", "Outcome note", [h("p", { text: warning })])),
          )
        : null,
      results.length > 0
        ? h("div", { class: "table-wrap" }, [
            h("table", {}, [
              h("caption", { text: `Problem outcomes${job.resultsTruncated ? " (truncated sample)" : ""}` }),
              h("thead", {}, [
                h(
                  "tr",
                  {},
                  ["Subject", "From", "Outcome", "Detail"].map((label) =>
                    h("th", { scope: "col", text: label }),
                  ),
                ),
              ]),
              h(
                "tbody",
                {},
                results.map((result) =>
                  h("tr", {}, [
                    h("td", { class: "wrap", text: result.subject ?? "(no subject)" }),
                    h("td", { class: "wrap", text: result.from ?? "—" }),
                    h("td", {}, [
                      badge(
                        result.outcome,
                        result.outcome === "failed"
                          ? "failed"
                          : result.outcome === "uncertain"
                            ? "warning"
                            : "info",
                      ),
                    ]),
                    h("td", { class: "wrap", text: result.detail }),
                  ]),
                ),
              ),
            ]),
          ])
        : h("p", {
            class: "small muted",
            text: running
              ? "Problems will appear here as they are detected."
              : "No failed, uncertain, or skipped outcomes were reported.",
          }),
      h("div", { class: "btn-row" }, [
        cancelButton,
        job.mode === "dry-run" && state.preview
          ? h("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Return to review",
              on: {
                click: () => {
                  state.job = null;
                  context.rerender();
                },
              },
            })
          : null,
        h("button", {
          class: "btn",
          type: "button",
          text: "New scan",
          on: {
            click: () => {
              stopPolling();
              state = { ...defaultState(), provider: state.provider };
              context.rerender();
            },
          },
        }),
        h("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "View activity",
          on: { click: () => context.navigate("activity") },
        }),
      ]),
      running
        ? h("p", {
            class: "hint",
            text: "You can leave this page; the job continues in the local server and appears in Activity. Cancellation does not roll back completed changes.",
          })
        : h("p", {
            class: "hint",
            text: "Results are a point-in-time report. Verify the mailbox in the provider's interface before relying on them.",
          }),
    ]),
  ]);
}

function startPolling(context: AppContext): void {
  stopPolling();
  pollFailures = 0;
  if (!state.job || (state.job.status !== "running" && state.job.status !== "queued")) return;
  const jobId = state.job.id;
  pollTimer = window.setInterval(() => {
    if (!viewActive) {
      stopPolling();
      return;
    }
    void getJob(jobId)
      .then((job) => {
        pollFailures = 0;
        state.job = job;
        if (job.status === "running" || job.status === "queued") {
          const progress = document.getElementById("cleanup-progress") as HTMLProgressElement | null;
          if (progress) progress.value = job.progress.processed;
          const label = document.getElementById("cleanup-progress-label");
          if (label)
            label.textContent = `${formatNumber(job.progress.processed)} of ${formatNumber(job.total)} processed`;
          const succeeded = document.getElementById("cleanup-succeeded");
          if (succeeded) succeeded.textContent = formatNumber(job.progress.succeeded);
          const failed = document.getElementById("cleanup-failed");
          if (failed) failed.textContent = formatNumber(job.progress.failed);
          const skipped = document.getElementById("cleanup-skipped");
          if (skipped) skipped.textContent = formatNumber(job.progress.skippedChanged);
          const uncertain = document.getElementById("cleanup-uncertain");
          if (uncertain) uncertain.textContent = formatNumber(job.progress.uncertain);
          return;
        }
        stopPolling();
        void context
          .refreshStatus()
          .catch(() => undefined)
          .then(() => context.rerender());
      })
      .catch((error: unknown) => {
        pollFailures += 1;
        if (pollFailures >= 3) {
          stopPolling();
          state.error = error instanceof ApiError ? error.message : "Lost contact with the cleanup job.";
          context.rerender();
        }
      });
  }, 1000);
}

export const renderCleanup: View = (root, context) => {
  viewActive = true;
  stopPolling();

  const connected = context.status.providers.filter((provider) => provider.connected);
  if (!state.provider && connected.length === 1) {
    state.provider = connected[0]?.provider ?? null;
  }
  if (state.provider && !connected.some((provider) => provider.provider === state.provider)) {
    state.provider = null;
  }
  const provider = context.status.providers.find((entry) => entry.provider === state.provider) ?? null;
  const providerConnected = Boolean(provider?.connected);
  const step = currentStep(providerConnected);

  const headerActions: HTMLElement[] = [];
  if (state.preview || state.job) {
    headerActions.push(
      h("button", {
        class: "btn",
        type: "button",
        text: "Reset cleanup",
        on: {
          click: () => {
            stopPolling();
            state = { ...defaultState(), provider: state.provider };
            context.rerender();
          },
        },
      }),
    );
  }

  append(root, [
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("div", { class: "eyebrow", text: "Mailbox maintenance" }),
        h("h1", { text: "Mailbox Cleanup" }),
        h("p", {
          text: "Scan metadata, review an explicit plan, then execute with bounded batches. Nothing is selected by default and scanning never changes messages.",
        }),
      ]),
      ...headerActions,
    ]),
    stepsNode(step),
    state.error ? alertBox("danger", "Action needed", [h("p", { text: state.error })]) : null,
    state.notice ? alertBox("info", "Status", [h("p", { text: state.notice })]) : null,
    h("section", { class: "card", "aria-labelledby": "cleanup-connect" }, [
      h("div", { class: "card-head" }, [
        h("h2", { id: "cleanup-connect", text: "1. Connect or select a provider" }),
        h("span", { class: "pill", text: "OAuth · memory-only tokens" }),
      ]),
      h("p", {
        class: "small muted",
        text: "MailSentry never asks for an email password. Read-only access is enough for scanning and dry runs; cleanup access is needed only to execute changes.",
      }),
      h(
        "div",
        { class: "provider-grid" },
        context.status.providers.map((entry) =>
          providerCard(entry, state.provider === entry.provider, context),
        ),
      ),
      provider && !provider.connected
        ? h("p", {
            class: "hint",
            text: "Select a connected account above to continue. If OAuth is not configured, see Settings and docs/PROVIDERS.md.",
          })
        : null,
    ]),
    providerConnected && provider && !state.preview && !state.job
      ? scanPanel(provider, context)
      : h("p", {
          class: "small muted",
          text: providerConnected
            ? "Use Start over or New scan to change criteria for a completed preview or job."
            : "The folder and filter steps appear after an account is connected and selected.",
        }),
    state.preview && provider ? previewPanel(state.preview, provider, context) : null,
    state.job ? jobPanel(state.job, context) : null,
  ]);

  if (state.job && (state.job.status === "running" || state.job.status === "queued")) {
    startPolling(context);
  }

  return () => {
    viewActive = false;
    stopPolling();
    scanController?.abort();
    scanController = null;
    state.busy = false;
  };
};
