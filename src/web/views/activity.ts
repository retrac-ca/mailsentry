import type { ActivityItem, CleanupJob } from "../../shared/types.js";
import { ApiError, getJob, loadActivity } from "../api.js";
import type { View } from "../context.js";
import { alertBox, badge, clear, emptyState, h } from "../dom.js";
import { actionName, formatBytes, formatDate, providerName } from "../format.js";

function statusBadge(status: ActivityItem["status"]): HTMLElement {
  const variant =
    status === "success"
      ? "pass"
      : status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : "warning";
  const label =
    status === "success"
      ? "Success"
      : status === "failed"
        ? "Failed"
        : status === "cancelled"
          ? "Cancelled"
          : "Partial";
  return badge(label, variant);
}

function jobResultNode(job: CleanupJob): HTMLElement {
  const warnings =
    job.warnings.length > 0
      ? alertBox("warning", "Outcome notes", [
          h(
            "ul",
            {},
            job.warnings.map((warning) => h("li", { text: warning })),
          ),
        ])
      : null;

  return h("div", { class: "stack" }, [
    h("div", { class: "card-head" }, [
      h("h2", { text: `${job.mode === "dry-run" ? "Dry run" : "Cleanup"} details` }),
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
    h("dl", { class: "kv" }, [
      h("dt", { text: "Provider" }),
      h("dd", { text: providerName(job.provider) }),
      h("dt", { text: "Action" }),
      h("dd", { text: actionName(job.action) }),
      h("dt", { text: "Mode" }),
      h("dd", { text: job.mode === "dry-run" ? "Dry run (no changes)" : "Execution" }),
      h("dt", { text: "Started" }),
      h("dd", { text: formatDate(job.startedAt ?? job.createdAt) }),
      h("dt", { text: "Finished" }),
      h("dd", { text: formatDate(job.finishedAt) }),
      h("dt", { text: "Processed" }),
      h("dd", { text: `${job.progress.processed} of ${job.total}` }),
      h("dt", { text: "Outcomes" }),
      h("dd", {
        text: `${job.progress.succeeded} succeeded · ${job.progress.failed} failed · ${job.progress.skippedChanged} skipped (changed) · ${job.progress.uncertain} uncertain`,
      }),
      h("dt", { text: "Storage freed" }),
      h("dd", { text: formatBytes(job.progress.bytesRecovered) }),
    ]),
    job.error ? alertBox("danger", "Job error", [h("p", { text: job.error })]) : null,
    warnings,
    job.results.length > 0
      ? h("div", { class: "table-wrap" }, [
          h("table", {}, [
            h("caption", { text: "Problem outcomes (bounded sample)" }),
            h("thead", {}, [
              h("tr", {}, [
                h("th", { scope: "col", text: "Subject" }),
                h("th", { scope: "col", text: "From" }),
                h("th", { scope: "col", text: "Outcome" }),
                h("th", { scope: "col", text: "Detail" }),
              ]),
            ]),
            h(
              "tbody",
              {},
              job.results.map((result) =>
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
      : h("p", { class: "small muted", text: "No failure, uncertain, or skipped results were reported." }),
    h("p", {
      class: "small muted",
      text: "Activity summaries are held in local server memory for this session and are lost when MailSentry restarts.",
    }),
  ]);
}

export const renderActivity: View = (root, context) => {
  const listSlot = h("div", {});
  const detailSlot = h("div", {});
  let disposed = false;

  const load = async (): Promise<void> => {
    clear(listSlot);
    listSlot.append(h("p", { class: "muted", text: "Loading activity…" }));
    try {
      const items = await loadActivity();
      if (disposed) return;
      clear(listSlot);
      if (items.length === 0) {
        listSlot.append(
          emptyState(
            "No activity yet",
            "Run an email health check or a cleanup scan. Nothing is recorded automatically.",
          ),
        );
        return;
      }
      listSlot.append(
        h(
          "div",
          { class: "grid" },
          items.map((item) => {
            const openDetails = (button: HTMLButtonElement) => {
              button.disabled = true;
              void getJob(item.id)
                .then((job) => {
                  if (disposed) return;
                  clear(detailSlot);
                  detailSlot.append(jobResultNode(job));
                  document.getElementById("activity-detail")?.focus();
                })
                .catch((error: unknown) => {
                  clear(detailSlot);
                  detailSlot.append(
                    alertBox("danger", "Could not load job", [
                      h("p", {
                        text: error instanceof ApiError ? error.message : "Job details are unavailable.",
                      }),
                    ]),
                  );
                })
                .finally(() => {
                  button.disabled = false;
                });
            };
            const viewButton: HTMLElement | null =
              item.kind === "cleanup"
                ? h("button", {
                    class: "btn btn-small",
                    type: "button",
                    text: "View details",
                    on: {
                      click: (event) => openDetails(event.currentTarget as HTMLButtonElement),
                    },
                  })
                : null;
            return h("article", { class: "card flat" }, [
              h("div", { class: "card-head" }, [h("h2", { text: item.title }), statusBadge(item.status)]),
              h("p", { class: "small muted", text: formatDate(item.at) }),
              h("p", { text: item.summary }),
              viewButton,
            ]);
          }),
        ),
      );
    } catch (error) {
      if (disposed) return;
      clear(listSlot);
      listSlot.append(
        alertBox("danger", "Could not load activity", [
          h("p", { text: error instanceof ApiError ? error.message : "The activity list is unavailable." }),
        ]),
      );
    }
  };

  const refresh = h("button", {
    class: "btn",
    type: "button",
    text: "Refresh",
    on: {
      click: () => {
        void context.refreshStatus().then(load);
      },
    },
  });

  root.append(
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("div", { class: "eyebrow", text: "Session history" }),
        h("h1", { text: "Activity / Results" }),
        h("p", {
          text: "Diagnostics and cleanup outcomes from this local session. Nothing is uploaded or persisted to disk.",
        }),
      ]),
      refresh,
    ]),
    h("section", { "aria-labelledby": "activity-list" }, [
      h("h2", { id: "activity-list", class: "section-head", text: "Recent activity" }),
      listSlot,
    ]),
    h("section", { class: "section", id: "activity-detail", tabindex: "-1", "aria-live": "polite" }, [
      detailSlot,
    ]),
  );

  void load();
  return () => {
    disposed = true;
  };
};
